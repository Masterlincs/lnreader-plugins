import { load as parseHTML } from 'cheerio';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { fetchApi } from '@libs/fetch';

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

class DevilNovels implements Plugin.PluginBase {
  id = 'DevilNovels';
  name = 'DevilNovels';
  icon = 'src/es/devilnovels/icon.png';
  site = 'https://devilnovels.com/';
  version = '1.0.6';

  async popularNovels(
    page: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const novels: Plugin.NovelItem[] = [];

    // Lógica diferenciada:
    // - Recientes: Home (tabla)
    // - Populares: Listado (grid)
    const url = showLatestNovels
      ? this.site
      : this.site + 'listado-de-novelas/';

    const res = await fetchApi(url);
    if (!res.ok) return novels;
    const body = await res.text();
    const $ = parseHTML(body);

    if (showLatestNovels) {
      // Parsear la tabla de la página de inicio para Recientes
      $('table tbody tr').each((i, el) => {
        const tds = $(el).find('td');
        // Aseguramos que haya columnas (la estructura mostrada tiene 2)
        if (tds.length < 2) return;

        // Columna 1: Imagen y Título de Novela
        const left = tds.first();
        // Columna 2: Último Capítulo

        const titleA = left.find('a').last(); // El <a> después del div de la imagen
        const href = titleA.attr('href') || '';
        const name = titleA.text().trim();

        // Imagen dentro del div
        const img = left.find('img').attr('src') || defaultCover;
        const path = href.replace(this.site, '');

        if (name && path) {
          novels.push({
            name,
            path,
            cover: img,
          });
        }
      });
    } else {
      // Lógica para Populares (mantiene el escrapeo del grid de 'listado-de-novelas')

      // 1) Grid de destacados
      $('.pvc-featured-pages-grid .pvc-featured-page-item').each((i, el) => {
        const item = $(el);
        const a = item.find('a').first();
        const href = a.attr('href') || '';
        const img = item.find('img').attr('src') || defaultCover;
        const title =
          item.find('p.pvc-page-title a').text().trim() ||
          a.attr('title') ||
          a.text().trim();
        const path = href.replace(this.site, '');
        if (title) novels.push({ name: title, path, cover: img });
      });

      // 2) Títulos sueltos si el grid falla o es diferente
      if (novels.length === 0) {
        $('p.pvc-page-title a').each((i, el) => {
          const a = $(el);
          const href = a.attr('href') || '';
          const title = a.text().trim();
          const parent = a.closest('.pvc-featured-page-item');
          const img =
            parent && parent.length
              ? parent.find('img').attr('src') || defaultCover
              : defaultCover;
          const path = href.replace(this.site, '');
          if (title) novels.push({ name: title, path, cover: img });
        });
      }
    }

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = novelPath.startsWith('http')
      ? novelPath
      : this.site + novelPath;
    const res = await fetchApi(url);
    const body = await res.text();
    const $ = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name:
        $('meta[property="og:title"]').attr('content') ||
        $('h1').first().text().trim() ||
        '',
      cover: $('meta[property="og:image"]').attr('content') || defaultCover,
      summary: undefined,
      chapters: [],
    };

    // Limpieza y extracción del resumen
    const entry = $('.entry-content').first();
    if (entry && entry.length) {
      const clone = entry.clone();
      clone
        .find(
          '.elementor-posts-container, .elementor-posts, .elementor-post, .elementor-pagination, .code-block, iframe, script, style, .ad, .adsbygoogle, .post-list, .chapter-list, [data-id="c7ecb4a"], .elementor-element-c7ecb4a',
        )
        .remove();

      clone.find('[class*="ad-"]').remove();

      const cleanedText = clone.text().trim();
      if (cleanedText) {
        novel.summary = cleanedText;
      } else {
        const firstP = entry
          .find('p')
          .filter((i, el) => !!$(el).text().trim())
          .first();
        if (firstP && firstP.length) novel.summary = firstP.text().trim();
      }
    }

    // Coleccionar capítulos vía AJAX (dv_load_chapters) — el sitio los carga por JS
    const pageHtml = await fetchApi(url).then(r => r.text());
    const catIdMatch = pageHtml.match(/var CAT_ID\s*=\s*(\d+)/);
    if (catIdMatch) {
      const catId = catIdMatch[1];
      let page = 1;
      let pages = 1;
      do {
        const fd = new FormData();
        fd.append('action', 'dv_load_chapters');
        fd.append('cat_id', catId);
        fd.append('page', String(page));
        fd.append('search', '');
        const aj = await fetchApi(this.site + 'wp-admin/admin-ajax.php', {
          method: 'POST',
          body: fd,
        }).then(r => r.json());

        for (const ch of aj.data?.chapters ?? []) {
          const link: string = ch.link;
          novel.chapters!.push({
            name: ch.title ?? `Capítulo ${page}`,
            path: link.replace(this.site, ''),
          });
        }
        pages = aj.data?.pages ?? 1;
        page++;
      } while (page <= pages);
      novel.chapters!.reverse();
    }

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = chapterPath.startsWith('http')
      ? chapterPath
      : this.site + chapterPath;
    const res = await fetchApi(url);
    const body = await res.text();
    const $ = parseHTML(body);

    const content =
      $('.entry-content').first().html() || $('article').first().html() || '';
    return content;
  }

  async searchNovels(
    searchTerm: string,
    page: number,
  ): Promise<Plugin.NovelItem[]> {
    const novels: Plugin.NovelItem[] = [];
    const pageQuery = page && page > 1 ? `&paged=${page}` : '';
    const url = `${this.site}?post_type=page&s=${encodeURIComponent(searchTerm)}${pageQuery}`;
    const res = await fetchApi(url);
    if (!res.ok) return novels;
    const body = await res.text();
    const $ = parseHTML(body);

    $('.ast-article-inner').each((i, el) => {
      const block = $(el);
      const a = block.find('h2.entry-title a').first();
      const href = a.attr('href') || '';
      const title = a.text().trim();
      const img = block.find('.post-thumb img').attr('src') || defaultCover;
      const path = href.replace(this.site, '');
      if (title) novels.push({ name: title, path, cover: img });
    });

    return novels;
  }

  filters = {} as any;
}

export default new DevilNovels();
