import {
    assignTransferProtocolMeta, marshalErrorLike,
    RPCHost, RPCReflection,
    AssertionFailureError,
    objHashMd5B64Of,
    TransferProtocolMetadata,
} from 'civkit';
import { singleton } from 'tsyringe';
import { AsyncContext, Logger } from '../shared/index';
import { RateLimitControl, RateLimitDesc } from '../shared/services/rate-limit';
import _ from 'lodash';
import { Request, Response } from 'express';
import { SearXNGSearchOperatorsDto, SearXNGSearchService } from '../services/searxng-search';
import { CrawlerHost, ExtraScrappingOptions, FormattedPage } from './crawler';
import { SearchResult } from '../db/searched';
import { SearXNGSearchResponse, SearXNGSearchResult } from '../services/searxng-search';
import { CrawlerOptions, CrawlerOptionsHeaderOnly } from '../dto/scrapping-options';


function sendResponse<T>(res: Response, data: T, meta: TransferProtocolMetadata): T {
    if(res.headersSent){
        return data;
    }
    if (meta.code) {
        res.status(meta.code);
    }
    if (meta.contentType) {
        res.type(meta.contentType);
    }
    if (meta.headers) {
        for (const [key, value] of Object.entries(meta.headers)) {
            if (value !== undefined) {
                res.setHeader(key, value);
            }
        }
    }
    res.send(data);
    return data;
}


@singleton()
export class SearXNGSearchHost extends RPCHost {
    logger = new Logger('Searcher');

    cacheRetentionMs = 1000 * 3600 * 24 * 7;
    cacheValidMs = 1000 * 3600;
    pageCacheToleranceMs = 1000 * 3600 * 24;

    reasonableDelayMs = 15_000;

    targetResultCount = 5;

    constructor(
        protected rateLimitControl: RateLimitControl,
        protected threadLocal: AsyncContext,
        protected searxngSearchService: SearXNGSearchService,
        protected crawler: CrawlerHost,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    async search(
        req: Request, res: Response
    ) {
        this.logger.info(`Crawl request received for URL: ${req.url}`);
        console.log('Crawl method called with request:', req.url);
        const ctx = { req, res };
        console.log(`req.headers: ${JSON.stringify(req.headers)}`);
        try {
            const crawlerOptionsHeaderOnly = CrawlerOptionsHeaderOnly.from(req);
            const crawlerOptionsParamsAllowed = CrawlerOptions.from(req.method === 'POST' ? req.body : req.query, req);
            const crawlerOptions = ctx.req.method === 'GET' ? crawlerOptionsHeaderOnly : crawlerOptionsParamsAllowed;
            console.log('Searcher options:', crawlerOptions);
            const searchQuery = decodeURIComponent(ctx.req.path).slice(3);
            const count = ctx.req.query['count'] ? Math.max(1, Math.min(Number(ctx.req.query['count']), 20)) : 5;
            const categories = ctx.req.query['categories'] ? String(ctx.req.query['categories']).split(',') : [];
            const engines = ctx.req.query['engines'] ? String(ctx.req.query['engines']).split(',') : [];
            const crawlOpts = await this.crawler.configure(crawlerOptions,req);
            const r = await this.cachedWebSearch({
                q: searchQuery,
                count: count,
                categories: categories,
                engines: engines,
                language: crawlOpts.locale
            }, crawlerOptions.noCache);

            let searchResultGenerator = this.fetchSearchResults(crawlerOptions.respondWith, r.results.slice(0, count), crawlOpts,
            CrawlerOptions.from({ ...crawlerOptions, cacheTolerance: crawlerOptions.cacheTolerance ?? this.pageCacheToleranceMs }),
            count,
            );
            let lastScrapped: any[] | undefined;
            let earlyReturnTimer: ReturnType<typeof setTimeout> | undefined;
            const setEarlyReturnTimer = () => {
                if (earlyReturnTimer) {
                    return;
                }
                earlyReturnTimer = setTimeout(() => {
                    if (!lastScrapped) {
                        return;
                    }
                    return sendResponse(ctx.res, `${lastScrapped}`, { contentType: 'text/plain', envelope: null });
                }, ((crawlerOptions.timeout || 0) * 1000) || this.reasonableDelayMs);
            };
            for await (const scrapped of searchResultGenerator) {
                lastScrapped = scrapped;

                if (_.some(scrapped, (x) => this.pageQualified(x))) {
                    setEarlyReturnTimer();
                }

                if (!this.searchResultsQualified(scrapped, count)) {
                    continue;
                }

                if (earlyReturnTimer) {
                    clearTimeout(earlyReturnTimer);
                }

                return sendResponse(ctx.res, `${scrapped}`, { contentType: 'text/plain', envelope: null });
            }

            if (earlyReturnTimer) {
                clearTimeout(earlyReturnTimer);
            }

            if (!lastScrapped) {
                throw new AssertionFailureError(`No content available for query ${searchQuery}`);
            }
            return sendResponse(ctx.res, `${lastScrapped}`, { contentType: 'text/plain', envelope: null })
        } catch (error) {
            console.error('Error in search method:', error);
            return sendResponse(res, 'Internal server error', { contentType: 'text/plain', envelope: null, code: 500 });
        }

    }

    async *fetchSearchResults(
        mode: string | 'markdown' | 'html' | 'text' | 'screenshot',
        searchResults?: SearXNGSearchResult[],
        options?: ExtraScrappingOptions,
        crawlerOptions?: CrawlerOptions,
        count?: number,
    ) {
        if (!searchResults) {
            return;
        }
        if (count === 0) {
            const resultArray = searchResults.map((upstreamSearchResult, i) => ({
                url: upstreamSearchResult.url,
                title: upstreamSearchResult.title,
                description: upstreamSearchResult.content,
                content: ['html', 'text', 'screenshot'].includes(mode) ? undefined : '',
                toString() {
                    return `[${i + 1}] Title: ${this.title}
[${i + 1}] URL Source: ${this.url}
[${i + 1}] Description: ${this.description}
`;
                }

            })) as FormattedPage[];
            resultArray.toString = function () {
                return this.map((x, i) => x ? x.toString() : '').join('\n\n').trimEnd() + '\n';
            };
            yield resultArray;
            return;
        }
        const urls = searchResults.map((x) => new URL(x.url));
        const snapshotMap = new WeakMap();
        for await (const scrapped of this.crawler.scrapMany(urls, options, crawlerOptions)) {
            const mapped = scrapped.map((x, i) => {
                const upstreamSearchResult = searchResults[i];
                if (!x) {
                    return {
                        url: upstreamSearchResult.url,
                        title: upstreamSearchResult.title,
                        description: upstreamSearchResult.content,
                        content: ['html', 'text', 'screenshot'].includes(mode) ? undefined : ''
                    };
                }
                if (snapshotMap.has(x)) {
                    return snapshotMap.get(x);
                }
                return this.crawler.formatSnapshot(mode, x, urls[i]).then((r) => {
                    r.title ??= upstreamSearchResult.title;
                    r.description = upstreamSearchResult.content;
                    snapshotMap.set(x, r);

                    return r;
                }).catch((err) => {
                    this.logger.error(`Failed to format snapshot for ${urls[i].href}`, { err: marshalErrorLike(err) });

                    return {
                        url: upstreamSearchResult.url,
                        title: upstreamSearchResult.title,
                        description: upstreamSearchResult.content,
                        content: x.text,
                    };
                });
            });

            const resultArray = await Promise.all(mapped) as FormattedPage[];

            yield this.reOrganizeSearchResults(resultArray, count);
        }
    }

    reOrganizeSearchResults(searchResults: FormattedPage[], count?: number) {
        const targetResultCount = count || this.targetResultCount;
        const [qualifiedPages, unqualifiedPages] = _.partition(searchResults, (x) => this.pageQualified(x));
        const acceptSet = new Set(qualifiedPages);

        const n = targetResultCount - qualifiedPages.length;
        for (const x of unqualifiedPages.slice(0, n >= 0 ? n : 0)) {
            acceptSet.add(x);
        }

        const filtered = searchResults.filter((x) => acceptSet.has(x)).slice(0, targetResultCount);

        const resultArray = filtered.map((x, i) => {
            return {
                ...x,
                toString(this: any) {
                    if (!this.content && this.description) {
                        if (this.title || x.textRepresentation) {
                            const textRep = x.textRepresentation ? `\n[${i + 1}] Content: \n${x.textRepresentation}` : '';
                            return `[${i + 1}] Title: ${this.title}
[${i + 1}] URL Source: ${this.url}
[${i + 1}] Description: ${this.description}${textRep}
`;
                        }

                        return `[${i + 1}] No content available for ${this.url}`;
                    }

                    const mixins: string[] = [];
                    if (this.description) {
                        mixins.push(`[${i + 1}] Description: ${this.description}`);
                    }
                    if (this.publishedTime) {
                        mixins.push(`[${i + 1}] Published Time: ${this.publishedTime}`);
                    }

                    const suffixMixins: string[] = [];
                    if (this.images) {
                        const imageSummaryChunks = [`[${i + 1}] Images:`];
                        for (const [k, v] of Object.entries(this.images)) {
                            imageSummaryChunks.push(`- ![${k}](${v})`);
                        }
                        if (imageSummaryChunks.length === 1) {
                            imageSummaryChunks.push('This page does not seem to contain any images.');
                        }
                        suffixMixins.push(imageSummaryChunks.join('\n'));
                    }
                    if (this.links) {
                        const linkSummaryChunks = [`[${i + 1}] Links/Buttons:`];
                        for (const [k, v] of Object.entries(this.links)) {
                            linkSummaryChunks.push(`- [${k}](${v})`);
                        }
                        if (linkSummaryChunks.length === 1) {
                            linkSummaryChunks.push('This page does not seem to contain any buttons/links.');
                        }
                        suffixMixins.push(linkSummaryChunks.join('\n'));
                    }

                    return `[${i + 1}] Title: ${this.title}
[${i + 1}] URL Source: ${this.url}${mixins.length ? `\n${mixins.join('\n')}` : ''}
[${i + 1}] Markdown Content:
${this.content}
${suffixMixins.length ? `\n${suffixMixins.join('\n')}\n` : ''}`;
                }
            };
        });

        resultArray.toString = function () {
            return this.map((x, i) => x ? x.toString() : `[${i + 1}] No content available for ${this[i].url}`).join('\n\n').trimEnd() + '\n';
        };

        return resultArray;
    }

    pageQualified(formattedPage: FormattedPage) {
        return formattedPage.title &&
            formattedPage.content ||
            formattedPage.screenshotUrl ||
            formattedPage.pageshotUrl ||
            formattedPage.text ||
            formattedPage.html;
    }

    searchResultsQualified(results: FormattedPage[], targetResultCount = this.targetResultCount) {
        return _.every(results, (x) => this.pageQualified(x)) && results.length >= targetResultCount;
    }

    async cachedWebSearch(query: { q: string, count: number; categories: string[], engines:string[], language?:string}, noCache: boolean = false) {
        const queryDigest = objHashMd5B64Of(query);
        let cache;
        if (!noCache) {
            cache = (await SearchResult.fromFirestoreQuery(
                SearchResult.COLLECTION.where('queryDigest', '==', queryDigest)
                    .orderBy('createdAt', 'desc')
                    .limit(1)
            ))[0];
            if (cache) {
                const age = Date.now() - cache.createdAt.valueOf();
                const stale = cache.createdAt.valueOf() < (Date.now() - this.cacheValidMs);
                this.logger.info(`${stale ? 'Stale cache exists' : 'Cache hit'} for search query "${query.q}", normalized digest: ${queryDigest}, ${age}ms old`, {
                    query, digest: queryDigest, age, stale
                });

                if (!stale) {
                    return cache.response as SearXNGSearchResponse;
                }
            }
        }

        try {
            function delay(ms: number) {
                return new Promise(resolve => setTimeout(resolve, ms));
            }

            let allResults: SearXNGSearchResult[] = [];
            let pageno = 1;

            // First page
            const firstResponse = await this.searxngSearchService.search({
                q: query.q,
                pageno,
                engines: query.engines,
                categories: query.categories,
                language: query.language

            });
            allResults = allResults.concat(firstResponse.results);

            // Get second page if needed
            if (allResults.length < query.count) {
                await delay(1000 + Math.random() * 1000); // Random delay between 1000-2000ms

                pageno += 1;
                const secondResponse = await this.searxngSearchService.search({
                    q: query.q,
                    pageno,
                    engines: query.engines,
                    categories: query.categories,
                    language: query.language
                });
                allResults = allResults.concat(secondResponse.results);
            }

            // Trim to exact count requested
            const r = {
                ...firstResponse,
                results: allResults.slice(0, query.count)
            };

            const nowDate = new Date();
            const record = SearchResult.from({
                query,
                queryDigest,
                response: r,
                createdAt: nowDate,
                expireAt: new Date(nowDate.valueOf() + this.cacheRetentionMs)
            });
            SearchResult.save(record.degradeForFireStore()).catch((err) => {
                this.logger.warn(`Failed to cache search result`, { err });
            });

            return r;
        } catch (err: any) {
            if (cache) {
                this.logger.warn(`Failed to fetch search result, but a stale cache is available. falling back to stale cache`, { err: marshalErrorLike(err) });

                return cache.response as SearXNGSearchResponse;
            }

            throw err;
        }
    }
}
