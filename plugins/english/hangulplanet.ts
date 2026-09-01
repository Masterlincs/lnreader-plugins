import { fetchApi } from '@libs/fetch';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { Plugin } from '@/types/plugin';
import { CheerioAPI, load as parseHTML } from 'cheerio';

class HangulPlanetPlugin implements Plugin.PluginBase {
  id = 'hangulplanet';
  name = 'HangulPlanet';
  icon = 'src/en/hangulplanet/icon.png';
  site = 'https://hangulplanet.com';
  version = '1.0.0';

  private async getPage(url: string): Promise<CheerioAPI> {
    const response = await fetchApi(new URL(url, this.site).toString());
    if (!response.ok) {
      throw new Error(`Could not reach HangulPlanet (${response.status}).`);
    }
    return parseHTML(await response.text());
  }

  private imageUrl(src?: string): string {
    if (!src) return defaultCover;

    const image = new URL(src, this.site);
    const original = image.searchParams.get('url');
    return original
      ? new URL(original, this.site).toString()
      : image.toString();
  }

  private novelPath(href?: string): string {
    if (!href) return '';
    const url = new URL(href, this.site);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 2 && parts[0] === 'novel' ? url.pathname : '';
  }

  private parseNovelList($: CheerioAPI): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    $('a[href*="/novel/"]').each((_, element) => {
      const link = $(element);
      const path = this.novelPath(link.attr('href'));
      const name =
        link.find('h3').first().text().trim() ||
        link.find('img').first().attr('alt')?.trim() ||
        '';

      if (!path || !name || seen.has(path)) return;
      seen.add(path);
      novels.push({
        name,
        path,
        cover: this.imageUrl(link.find('img').first().attr('src')),
      });
    });

    return novels;
  }

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions<undefined>,
  ): Promise<Plugin.NovelItem[]> {
    const url = new URL('/browse', this.site);
    url.searchParams.set('sort', showLatestNovels ? 'latest' : 'popular');
    if (pageNo > 1) url.searchParams.set('page', pageNo.toString());
    return this.parseNovelList(await this.getPage(url.toString()));
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url = new URL('/browse', this.site);
    url.searchParams.set('q', searchTerm.trim());
    if (pageNo > 1) url.searchParams.set('page', pageNo.toString());
    return this.parseNovelList(await this.getPage(url.toString()));
  }

  private parseChapters($: CheerioAPI): Plugin.ChapterItem[] {
    const chapters: Plugin.ChapterItem[] = [];

    $('#chapters a[href*="/chapter-"]').each((_, element) => {
      const link = $(element);
      const url = new URL(link.attr('href') || '', this.site);
      const match = url.pathname.match(/\/chapter-(\d+(?:\.\d+)?)\/?$/);
      if (!match) return;

      const title = link.find('span.line-clamp-1').first().text().trim();
      if (!title) return;

      chapters.push({
        name: title,
        path: url.pathname,
        chapterNumber: Number.parseFloat(match[1]),
        releaseTime: link.find('time').attr('datetime') || null,
      });
    });

    return chapters;
  }

  private status(text: string): string {
    switch (text.toLowerCase()) {
      case 'ongoing':
        return NovelStatus.Ongoing;
      case 'completed':
      case 'complete':
        return NovelStatus.Completed;
      case 'hiatus':
        return NovelStatus.OnHiatus;
      case 'cancelled':
      case 'canceled':
        return NovelStatus.Cancelled;
      default:
        return NovelStatus.Unknown;
    }
  }

  private summary($: CheerioAPI): string | undefined {
    const section = $('h2')
      .filter((_, element) => $(element).text().trim() === 'Synopsis')
      .first()
      .closest('section');
    const paragraphs = section
      .find('p')
      .map((_, element) => $(element).text().trim())
      .get()
      .filter(Boolean);
    return paragraphs.length ? paragraphs.join('\n\n') : undefined;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novelUrl = new URL(novelPath, this.site);
    novelUrl.search = '';
    const firstPage = await this.getPage(novelUrl.toString());
    const title = firstPage('h1').first().text().trim();
    const details = firstPage('h1').first().closest('section');
    const cover = this.imageUrl(details.find('img').first().attr('src'));
    const author = firstPage('h1')
      .first()
      .parent()
      .find('p')
      .first()
      .text()
      .trim();
    const status = details
      .find('span')
      .map((_, element) => firstPage(element).text().trim())
      .get()
      .find(text =>
        /^(ongoing|completed|complete|hiatus|cancelled|canceled)$/i.test(text),
      );
    const genres = details
      .find('a[href*="/browse?genre="]')
      .map((_, element) => firstPage(element).text().trim())
      .get()
      .filter(Boolean)
      .join(', ');
    const rating = details.find('[aria-label$="out of 5"]').attr('aria-label');
    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= 100; page += 1) {
      let loaded = firstPage;
      if (page > 1) {
        const pageUrl = new URL(novelUrl.toString());
        pageUrl.searchParams.set('cpage', page.toString());
        loaded = await this.getPage(pageUrl.toString());
      }

      const pageChapters = this.parseChapters(loaded);
      if (pageChapters.length === 0) break;
      const previousCount = chapters.length;
      for (const chapter of pageChapters) {
        if (!seen.has(chapter.path)) {
          seen.add(chapter.path);
          chapters.push(chapter);
        }
      }
      if (chapters.length === previousCount) break;
    }

    chapters.sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

    return {
      path: novelUrl.pathname,
      name: title,
      cover,
      author: author || undefined,
      summary: this.summary(firstPage),
      status: this.status(status || ''),
      genres: genres || undefined,
      rating: rating ? Number.parseFloat(rating) : undefined,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const page = await this.getPage(chapterPath);
    const article = page('article[data-reader-article]').first();
    if (!article.length)
      throw new Error('Could not find HangulPlanet chapter content.');

    article
      .find('script, style, noscript, button, [data-reader-controls]')
      .remove();
    const content = article.html()?.trim() || '';
    if (!content) throw new Error('HangulPlanet returned an empty chapter.');
    return content;
  }
}

export default new HangulPlanetPlugin();
