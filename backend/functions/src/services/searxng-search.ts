import { AsyncService, AutoCastable, DownstreamServiceFailureError, Prop, RPC_CALL_ENVIRONMENT, delay, marshalErrorLike } from 'civkit';
import { singleton } from 'tsyringe';
import { Logger } from '../shared/index';
import { SecretExposer } from '../shared/services/secrets';
import { GEOIP_SUPPORTED_LANGUAGES, GeoIPService } from './geoip';
import { AsyncContext } from '../shared';
import type { Request, Response } from 'express';
import axios from 'axios';

export interface SearXNGSearchParams {
    q: string;
    categories?: string[];
    engines?: string[];
    language?: string;
    pageno?: number;
    time_range?: 'day' | 'month' | 'year';
    format?: 'json' | 'csv' | 'rss';
    results_on_new_tab?: boolean;
    image_proxy?: boolean;
    autocomplete?: string;
    safesearch?: number;
    theme?: string;
    enabled_plugins?: string[];
    disabled_plugins?: string[];
    enabled_engines?: string[];
    disabled_engines?: string[];
}

export interface SearXNGSearchResult {
    url: string;
    title: string;
    content: string;
    engine: string;
    template: string;
    parsed_url: [string, string, string, string, string, string];
    engines: string[];
    positions: number[];
    score: number;
    category: string;
}

export class SearXNGSearchResponse {
    query: string;
    number_of_results: number;
    results: SearXNGSearchResult[];
    answers: any[];
    corrections: any[];
    infoboxes: any[];
    suggestions: any[];
    unresponsive_engines: string[];

    constructor(data: any) {
        this.query = data.query;
        this.number_of_results = data.number_of_results;
        this.results = data.results;
        this.answers = data.answers;
        this.corrections = data.corrections;
        this.infoboxes = data.infoboxes;
        this.suggestions = data.suggestions;
        this.unresponsive_engines = data.unresponsive_engines;
    }
}

@singleton()
export class SearXNGSearchService extends AsyncService {
    logger = new Logger('SearXNGSearchService');
    baseUrl = process.env.SEARXNG_INSTANCE_URL || 'http://localhost:8080';

    constructor(
        protected secretExposer: SecretExposer,
        protected geoipControl: GeoIPService,
        protected threadLocal: AsyncContext,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.emit('ready');
    }

    async search(query: SearXNGSearchParams) {


        // Create URLSearchParams with all possible parameters
        const params = new URLSearchParams({
            q: query.q,
            format: 'json',
            ...(query.language && { language: query.language }),
            ...(query.pageno && { pageno: query.pageno.toString() }),
            ...(query.time_range && { time_range: query.time_range }),
        });

        // Handle array parameters
        const arrayParams = {
            categories: query.categories,
            engines: query.engines,
            enabled_engines: query.enabled_engines,
            disabled_engines: query.disabled_engines
        };

        for (const [key, value] of Object.entries(arrayParams)) {
            if (value && Array.isArray(value)) {
                params.append(key, value.join(','));
            }
        }

        let maxTries = 5;
        while (maxTries--) {
            try {
                const response = await axios.get(`${this.baseUrl}/search`, {
                    params,
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': this.threadLocal.get('userAgent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0'
                    },
                    validateStatus: (status) => status >= 200 && status < 300
                });

                // Validate response structure
                if (!response.data || typeof response.data !== 'object') {
                    throw new DownstreamServiceFailureError({
                        message: 'Invalid response format from search service'
                    });
                }

                try {
                    return new SearXNGSearchResponse(response.data);
                } catch (err) {
                    throw new DownstreamServiceFailureError({
                        message: 'Failed to parse search response',
                        cause: err
                    });
                }
            } catch (err: any) {
                this.logger.error(`Search failed: ${err?.message}`, { err: marshalErrorLike(err) });
                if (err?.response?.status === 429) {
                    await delay(500 + 1000 * Math.random());
                    continue;
                }

                throw new DownstreamServiceFailureError({ message: `Search failed` });
            }
        }

        throw new DownstreamServiceFailureError({ message: `Search failed` });
    }
}

export class SearXNGSearchOperatorsDto extends AutoCastable {
    @Prop({
        arrayOf: String,
        desc: `Specifies the active search categories`
    })
    categories?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Specifies the active search engines`
    })
    engines?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Code of the language`
    })
    language?: string | string[];

    @Prop({
        arrayOf: String,
        desc: `Time range of search`
    })
    time_range?: string | string[];

    addTo(searchTerm: string) {
        const chunks: string[] = [];
        for (const [key, value] of Object.entries(this)) {
            if (value) {
                const values = Array.isArray(value) ? value : [value];
                const textValue = values.map((v) => `${key}:${v}`).join(' OR ');
                if (textValue) {
                    chunks.push(textValue);
                }
            }
        }
        const opPart = chunks.length > 1 ? chunks.map((x) => `(${x})`).join(' AND ') : chunks;

        if (opPart.length) {
            return [searchTerm, opPart].join(' ');
        }

        return searchTerm;
    }

    static override from(input: any) {
        const instance = super.from(input) as SearXNGSearchOperatorsDto;
        const ctx = Reflect.get(input, RPC_CALL_ENVIRONMENT) as {
            req: Request,
            res: Response,
        } | undefined;

        const params = ['categories', 'engines', 'language', 'time_range'];

        for (const p of params) {
            const customValue = ctx?.req.get(`x-${p}`) || ctx?.req.get(`${p}`);
            if (!customValue) {
                continue;
            }

            const filtered = customValue.split(', ').filter(Boolean);
            if (filtered.length) {
                Reflect.set(instance, p, filtered);
            }
        }

        return instance;
    }
}
