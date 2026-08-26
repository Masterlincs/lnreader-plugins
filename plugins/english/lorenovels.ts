import { load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';

class LoreNovels implements Plugin.PluginBase {
  id = 'lorenovels';
  name = 'Lore Novels';
  icon = 'src/en/lorenovels/icon.png';
  site = 'https://lorenovels.com';
  version = '1.0.3';

  private resolvePath(href?: string | null): string | undefined {
    if (!href) return undefined;
    if (href.startsWith('http')) {
      const url = new URL(href);
      if (!url.hostname.endsWith('lorenovels.com')) return undefined;
      return url.pathname;
    }
    if (!href.startsWith('/')) return `/${href}`;
    return href;
  }

  private resolveCover(src?: string | null): string | undefined {
    if (!src || src.startsWith('data:')) return undefined;
    if (src.startsWith('http')) return src;
    return new URL(src, this.site).toString();
  }

  private parseHomeNovels(loadedCheerio: ReturnType<typeof parseHTML>) {
    const container = loadedCheerio(
      'div.entry-content.alignwide.wp-block-post-content',
    ).first();
    const root = (container.length ? container : loadedCheerio.root()) as any;
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    root.find('div.wp-block-column').each((_: any, el: any) => {
      const column = loadedCheerio(el);
      const link = column.find('h2 a').first().attr('href');
      const name = column.find('h2 a').first().text().trim();
      const img = column.find('figure img').first();
      const cover = this.resolveCover(img.attr('data-src') || img.attr('src'));
      const path = this.resolvePath(link);

      if (!name || !path || seen.has(path)) return;
      seen.add(path);
      novels.push({
        name,
        path,
        cover,
      });
    });

    return novels;
  }

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const body = await fetchApi(this.site).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    if (showLatestNovels) {
      return this.parseHomeNovels(loadedCheerio);
    }

    return this.parseHomeNovels(loadedCheerio);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const body = await fetchApi(this.site + novelPath).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    let name = loadedCheerio('h1.entry-title, h1.wp-block-post-title, h1')
      .first()
      .text()
      .trim();

    const contentImg = loadedCheerio(
      'div.entry-content figure.wp-block-image img',
    ).first();
    const wpImg = loadedCheerio(
      'div.entry-content img[class*="wp-image-"]',
    ).first();
    const postImg = loadedCheerio('img.wp-post-image').first();
    const blockImg = loadedCheerio('.wp-block-image img').first();
    const figImg = loadedCheerio('figure img').first();
    const firstImg = loadedCheerio('div.entry-content img').first();

    const cover = this.resolveCover(
      contentImg.attr('data-src') ||
        contentImg.attr('src') ||
        wpImg.attr('data-src') ||
        wpImg.attr('src') ||
        postImg.attr('data-src') ||
        postImg.attr('src') ||
        blockImg.attr('data-src') ||
        blockImg.attr('src') ||
        figImg.attr('data-src') ||
        figImg.attr('src') ||
        firstImg.attr('data-src') ||
        firstImg.attr('src'),
    );

    // Extract metadata from labeled wp-block-group sections
    const metaLabels = [
      'title:',
      'author:',
      'genre:',
      'genres:',
      'status:',
      'artist:',
    ];
    let author: string | undefined;
    let genres: string | undefined;
    let status: string | undefined;
    let artist: string | undefined;

    loadedCheerio('div.wp-block-group.is-vertical').each((_, el) => {
      const group = loadedCheerio(el);
      const label = group.find('p').first().text().trim().toLowerCase();
      if (!metaLabels.includes(label)) return;

      const value =
        group.find('h2').first().text().trim() ||
        group.find('.wp-block-button__link').first().text().trim();
      if (!value) return;

      if (label === 'title:') {
        if (!name || name === 'Untitled') {
          name = value;
        }
      } else if (label === 'author:') author = value;
      else if (label === 'genre:' || label === 'genres:') genres = value;
      else if (label === 'status:') status = value;
      else if (label === 'artist:') artist = value;
    });

    // Extract summary from paragraphs that are NOT metadata labels
    const summaryParts: string[] = [];
    loadedCheerio('div.entry-content p').each((_, el) => {
      const text = loadedCheerio(el).text().trim();
      if (!text) return;
      if (metaLabels.includes(text.toLowerCase())) return;
      summaryParts.push(text);
    });
    const summary = summaryParts.join('\n\n') || undefined;

    // Extract chapters from wp-block-latest-posts and generic links
    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<string>();

    // Latest posts block (primary chapter list)
    loadedCheerio('.wp-block-latest-posts__post-title').each((_, el) => {
      const anchor = loadedCheerio(el);
      const href = anchor.attr('href');
      const path = this.resolvePath(href);
      const title = anchor.text().trim();

      if (!path || !title || seen.has(path)) return;
      seen.add(path);
      chapters.push({ name: title, path });
    });

    // Fallback: entry-content links
    loadedCheerio('div.entry-content a:not(.wp-block-button__link)').each(
      (_, el) => {
        const anchor = loadedCheerio(el);
        const href = anchor.attr('href');
        const path = this.resolvePath(href);
        const title = anchor.text().trim();

        if (!path || !title) return;
        if (path.includes('#') || path.includes('/wp-content/')) return;
        if (!/chapter|cap|ch\.?\s?\d/i.test(title) && !/chapter/i.test(path)) {
          return;
        }
        if (seen.has(path)) return;
        seen.add(path);

        chapters.push({
          name: title,
          path,
        });
      },
    );

    return {
      path: novelPath,
      name: name || 'Untitled',
      cover,
      summary,
      author,
      artist,
      genres,
      status,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const body = await fetchApi(this.site + chapterPath).then(res =>
      res.text(),
    );
    const loadedCheerio = parseHTML(body);

    const title = loadedCheerio('h1.wp-block-post-title').text().trim();

    loadedCheerio(
      'script, style, .sharedaddy, .wp-block-buttons, nav, form, .comment-respond, .not-a-member-block, .site-comments, .wp-block-post-navigation-link',
    ).remove();

    loadedCheerio('div.entry-content img').each((_, el) => {
      const img = loadedCheerio(el);
      const dataSrc = img.attr('data-src');
      if (dataSrc) {
        img.attr('src', dataSrc);
        img.removeAttr('data-src');
      }
    });

    const content = loadedCheerio('div.entry-content').html() || '';

    return `<h1>${title}</h1>\n${content}`;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const url = `${this.site}/?s=${encodeURIComponent(searchTerm)}`;
    const body = await fetchApi(url).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    loadedCheerio('article').each((_, el) => {
      const article = loadedCheerio(el);
      const link = article.find('h2 a, h1 a').first().attr('href');
      const name = article.find('h2, h1').first().text().trim();
      const searchImg = article.find('img').first();
      const cover = this.resolveCover(
        searchImg.attr('data-src') || searchImg.attr('src'),
      );
      const path = this.resolvePath(link);

      if (!name || !path || seen.has(path)) return;
      if (/chapter|cap|ch\.?\s?\d/i.test(name)) return;

      seen.add(path);
      novels.push({
        name,
        path,
        cover,
      });
    });

    if (novels.length) return novels;

    return this.parseHomeNovels(loadedCheerio);
  }
}

export default new LoreNovels();
