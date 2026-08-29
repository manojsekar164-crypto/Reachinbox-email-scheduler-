import { Client } from '@elastic/elasticsearch';

const esUrl = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';

// Initialize the single, reusable Elasticsearch client instance
export const esClient = new Client({
  node: esUrl,
  // Support basic authentication credentials if specified in environment variables
  auth: process.env.ELASTIC_USERNAME && process.env.ELASTIC_PASSWORD ? {
    username: process.env.ELASTIC_USERNAME,
    password: process.env.ELASTIC_PASSWORD,
  } : undefined,
});
