import { Request, Response } from 'express';
import { searchEmails } from '../services/searchService';
import { UserRow } from '../types/db.types';

/**
 * GET /emails/search
 * Secure search endpoint. Only returns emails belonging to the authenticated user.
 */
export async function searchEmailsController(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const user = req.user as UserRow;
    if (!user || !user.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    // Parse pagination options safely
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    // Parse optional range filter constraints
    const scheduledAtStart = typeof req.query.scheduledAtStart === 'string' ? req.query.scheduledAtStart : undefined;
    const scheduledAtEnd = typeof req.query.scheduledAtEnd === 'string' ? req.query.scheduledAtEnd : undefined;
    const sentAtStart = typeof req.query.sentAtStart === 'string' ? req.query.sentAtStart : undefined;
    const sentAtEnd = typeof req.query.sentAtEnd === 'string' ? req.query.sentAtEnd : undefined;

    const searchResult = await searchEmails(
      user.id,
      q,
      {
        status,
        scheduledAtStart,
        scheduledAtEnd,
        sentAtStart,
        sentAtEnd
      },
      {
        page,
        limit
      }
    );

    res.json({
      query: q || '',
      count: searchResult.count,
      results: searchResult.results
    });
  } catch (error: any) {
    console.error(`❌ [Search API] Search request failed: ${error.message}`);
    // Safe response masking internal Elasticsearch stack traces
    res.status(500).json({
      error: 'Search service is temporarily unavailable. Please try again later.'
    });
  }
}
