import { and, desc, eq, getTableColumns, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import sanitizeHtml from 'sanitize-html';
import { blogPosts } from './db/schema';

const { body, bodyEn, ...summaryColumns } = getTableColumns(blogPosts);
const published = lte(blogPosts.publishedAt, sql`date('now')`);
const articleHtml = (html: string): string => sanitizeHtml(html, {
  allowedTags: ['p', 'h2', 'h3', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'blockquote', 'br'],
  allowedAttributes: { p: ['class'], a: ['href'] },
  allowedClasses: { p: ['pull'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
});

export function registerBlogRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/blog', async (c) => {
    const posts = await drizzle(c.env.DB).select(summaryColumns).from(blogPosts)
      .where(published).orderBy(desc(blogPosts.featured), desc(blogPosts.publishedAt), blogPosts.slug);
    return c.json({ posts });
  });

  app.get('/blog/:slug', async (c) => {
    const post = await drizzle(c.env.DB).select().from(blogPosts)
      .where(and(eq(blogPosts.slug, c.req.param('slug')), published)).get();
    if (!post) return c.json({ error: 'Article not found.' }, 404);
    return c.json({ post: { ...post, body: articleHtml(post.body), bodyEn: articleHtml(post.bodyEn) } });
  });
}
