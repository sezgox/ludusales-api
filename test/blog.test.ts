import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('public blog', () => {
  it('lists the four articles with the featured article first and reads changes directly from D1', async () => {
    await testEnv.DB.prepare('UPDATE blog_posts SET excerpt = ? WHERE slug = ?')
      .bind('Updated in D1', 'senales-equipo').run();
    const response = await app.request('/blog', {}, testEnv);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { posts: Array<Record<string, unknown>> };
    expect(body.posts.map((post) => post['slug'])).toEqual(['senales-equipo', 'ranking-sano', 'piloto-30-dias', 'que-puntuar']);
    expect(body.posts[0]).toMatchObject({ featured: true, excerpt: 'Updated in D1' });
    expect(body.posts[0]).not.toHaveProperty('body');
  });

  it('returns both article languages and rejects unpublished articles and unknown slugs', async () => {
    const response = await app.request('/blog/senales-equipo', {}, testEnv);
    expect(response.status).toBe(200);
    const { post } = (await response.json()) as { post: { title: string; body: string; bodyEn: string } };
    expect(post.title).toBe('5 señales de que tu equipo comercial necesita gamificación');
    expect(post.body).toContain('<h2>');
    expect(post.bodyEn).toContain('<h2>');
    expect(post.body).toContain('class="pull"');

    await testEnv.DB.prepare('UPDATE blog_posts SET published_at = NULL WHERE slug = ?').bind('ranking-sano').run();
    expect((await app.request('/blog/ranking-sano', {}, testEnv)).status).toBe(404);
    expect((await app.request('/blog/desconocido', {}, testEnv)).status).toBe(404);
  });
});
