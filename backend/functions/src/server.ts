import 'reflect-metadata';
import express from 'express';
import { container } from 'tsyringe';
import { CrawlerHost } from './cloud-functions/crawler';
import path from 'path';
import { SearXNGSearchHost } from './cloud-functions/searxng-searcher';

const app = express();
const port = process.env.PORT || 3000;

const crawlerHost = container.resolve(CrawlerHost);
const searXNGSearchHost = container.resolve(SearXNGSearchHost)

app.use(express.json());

// Serve static files from the local-storage directory
app.use('/instant-screenshots', express.static(path.join('/app', 'local-storage', 'instant-screenshots')));

// Handle favicon requests with 404
app.get('/favicon.ico', (req, res) => {
  res.status(404).end();
});
app.all('/s/*', async (req, res) => {
  try {
    await searXNGSearchHost.search(req, res);
  } catch (error: any) {
    console.error('Error during crawl:', error);

    // Kontrola typu chyby
    if (error.message.includes('Invalid TLD')) {
      res.status(400).json({ error: 'Invalid URL or TLD' });
    } else {
      // Ošetrenie iných chýb
      res.status(500).json({ error: 'An error occurred during the crawl' });
    }
  }
})
app.all('/r/*', async (req, res) => {
  try {
    await crawlerHost.crawl(req, res);
  } catch (error: any) {
    console.error('Error during crawl:', error);

    // Kontrola typu chyby
    if (error.message.includes('Invalid TLD')) {
      res.status(400).json({ error: 'Invalid URL or TLD' });
    } else {
      // Ošetrenie iných chýb
      res.status(500).json({ error: 'An error occurred during the crawl' });
    }
  }
});
app.all('*', async (req, res) => {
  res.status(200).json({
    openapi: "3.1.0",
    info: {
      title: "API Documentation",
      version: "1.0.0",
      description: "API for web crawling and searching functionality"
    },
    paths: {
      "/s/{q}": {
        get: {
          summary: "Perform a search",
          description: "Search using the SearXNG search engine",
          parameters: [
            {
              name: "q",
              in: "path",
              description: "Search query",
              required: true,
              schema: {
                type: "string"
              }
            },
            {
              name: "count",
              in: "query",
              description: "Number of results to return (1-20)",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 20
              }
            },
            {
              name: "categories",
              in: "query",
              description: "Comma-separated list of search categories",
              schema: {
                type: "string"
              }
            },
            {
              name: "engines",
              in: "query",
              description: "Comma-separated list of search engines",
              schema: {
                type: "string"
              }
            },
            {
              name: "X-Respond-With",
              in: "header",
              description: "Specifies the response format. Supported values: markdown, html, text, screenshot",
              schema: {
                type: "string"
              }
            },
            {
              name: "X-Timeout",
              in: "header",
              description: "Timeout in seconds",
              schema: {
                type: "integer"
              }
            }
          ],
          responses: {
            "200": {
              description: "Search results in requested format",
              content: {
                "text/plain": {
                  schema: {
                    type: "string",
                    example: "[1] Title: Example Title\n[1] URL Source: https://example.com\n[1] Description: Example description"
                  }
                }
              }
            },
            "400": {
              description: "Invalid search parameters"
            },
            "500": {
              description: "Internal server error during search"
            }
          }
        }
      },
      "/r": {
        post: {
          summary: "Crawl a website with POST",
          description: "Crawl and analyze a website using POST request. Supports request body parameters.",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: {
                      type: "string",
                      description: "URL to crawl"
                    },
                    html: {
                      type: "string",
                      description: "HTML content to parse directly"
                    },
                    respondWith: {
                      type: "string",
                      description: "Response format",
                      enum: ["markdown", "html", "text", "pageshot", "screenshot"]
                    },
                    timeout: {
                      type: "integer",
                      description: "Timeout in seconds (max 180)",
                      minimum: 1,
                      maximum: 180
                    }
                  },
                  required: ["url"]
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Successful crawl with requested format"
            },
            "400": {
              description: "Invalid URL or TLD"
            },
            "404": {
              description: "No content available"
            },
            "500": {
              description: "Internal server error during crawling"
            }
          }
        }
      },
      "/r/{url}": {
        get: {
          summary: "Crawl a website",
          description: "Crawl and analyze a website. Supports various headers to control crawling behavior.",
          parameters: [
            {
              name: "url",
              in: "path",
              description: "URL to crawl",
              required: true,
              schema: {
                type: "string"
              }
            },
            {
              name: "X-Respond-With",
              in: "header",
              description: "Specifies the response format. Supported values: markdown, html, text, pageshot, screenshot",
              schema: {
                type: "string"
              }
            },
            {
              name: "X-Wait-For-Selector",
              in: "header",
              description: "CSS selector to wait for before returning",
              schema: {
                type: "string"
              }
            },
            {
              name: "X-Target-Selector",
              in: "header",
              description: "CSS selector to target specific elements",
              schema: {
                type: "string"
              }
            },
            {
              name: "X-Remove-Selector",
              in: "header",
              description: "CSS selector to remove elements from result",
              schema: {
                type: "string"
              }
            },
            {
              name: "X-Proxy-Url",
              in: "header",
              description: "Proxy URL to use for crawling",
              schema: {
                type: "string"
              }
            },
            {
              name: "X-Timeout",
              in: "header",
              description: "Timeout in seconds (max 180)",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 180
              }
            },
            {
              name: "X-With-Generated-Alt",
              in: "header",
              description: "Enable automatic alt-text generation for images",
              schema: {
                type: "boolean"
              }
            },
            {
              name: "X-With-Images-Summary",
              in: "header",
              description: "Include image summary in response",
              schema: {
                type: "boolean"
              }
            },
            {
              name: "X-With-Links-Summary",
              in: "header",
              description: "Include link summary in response",
              schema: {
                type: "boolean"
              }
            }
          ],
          responses: {
            "200": {
              description: "Successful crawl with requested format"
            },
            "400": {
              description: "Invalid URL or TLD"
            },
            "404": {
              description: "No content available"
            },
            "500": {
              description: "Internal server error during crawling"
            }
          }
        }
      }
    }
  });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

export default app;
