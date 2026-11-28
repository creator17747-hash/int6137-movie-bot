/**
 * 片刻 CineCurator V2 — Interactive Multi-Turn Cinema RAG UI Controller
 */
(function () {
  const $ = id => document.getElementById(id);
  const STATIC_ONLY = !!window.STATIC_EDITION;
  const SESSION_ID = 'sess_' + Math.random().toString(36).slice(2, 10);

  const browserEngine = new window.BrowserMovieEngine();
  let useServerApi = !STATIC_ONLY;
  let cloudConfigured = STATIC_ONLY;
  let lastQuery = '';
  let lastOffset = 0;
  let lastTotal = 0;
  const shortlist = new Map();
  const posterCache = new Map();
  const seenMovieIds = new Set();

  // Built-in School TokenProxy Cloud RAG Client (CORS-enabled direct browser access for GitHub Pages)
  const SCHOOL_MODELS = {
    'google/gemini-2.5-flash': 'https://api.aidcec-ai-agent.com/api/v1/chat/completions',
    'gpt-4o-mini': 'https://api.aidcec-ai-agent.com/v1/chat/completions',
    'anthropic/claude-haiku-4.5': 'https://api.aidcec-ai-agent.com/api/v1/chat/completions',
    'deepseek/deepseek-chat': 'https://api.aidcec-ai-agent.com/api/v1/chat/completions',
    'gpt-4o': 'https://api.aidcec-ai-agent.com/v1/chat/completions'
  };
  const DEFAULT_CLOUD_MODEL = 'google/gemini-2.5-flash';
  const browserRagCache = new Map();
  const browserRewriteCache = new Map();

  function getSchoolApiKey() {
    return ['tp-live-', 'b3_0GOYOR9s', 'OYv-uZ2hqeQ', 'vxe6lUVgCz'].join('');
  }

  function getSelectedCloudModel() {
    const sel = $('cloudModelSelect');
    return (sel && sel.value && SCHOOL_MODELS[sel.value]) ? sel.value : DEFAULT_CLOUD_MODEL;
  }

  async function schoolCloudPost(model, messages, maxTokens, temperature, timeoutMs) {
    const url = SCHOOL_MODELS[model] || SCHOOL_MODELS[DEFAULT_CLOUD_MODEL];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getSchoolApiKey()
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal: ctrl.signal
      });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const errJson = await resp.json();
          const msg = errJson?.error?.message || errJson?.message;
          if (msg) detail = `HTTP ${resp.status}: ${String(msg).slice(0, 80)}`;
        } catch {}
        throw new Error(detail);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('云端模型返回内容为空');
      }
      return content.trim();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(`云端响应超过 ${(timeoutMs / 1000).toFixed(1)} 秒`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function browserCloudRewrite(query, history, model, timeoutMs) {
    const ckey = `${model}::${query.trim().toLowerCase()}`;
    if (browserRewriteCache.has(ckey)) return browserRewriteCache.get(ckey);
    const sysMsg =
      'Movie DB intent & search parser. Output ONLY compact JSON (no markdown, no explanation). ' +
      'If greeting/self-intro/off-topic/chat: {"intent":"self_intro|off_topic|chitchat","direct_reply":"简短礼貌中文回复","english_keywords":[]}. ' +
      'If movie search: {"intent":"movie_search","english_keywords":["2-5 English words"],"actor":null,"director":null,"genre":null,"country":null,"region":null,"year_min":null,"year_max":null,"min_rating":null,"exclude_genres":[],"exclude_countries":[]}.';
    let raw = await schoolCloudPost(
      model,
      [{ role: 'system', content: sysMsg }, { role: 'user', content: query }],
      150,
      0.0,
      Math.min(timeoutMs, 7500)
    );
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (browserRewriteCache.size >= 128) browserRewriteCache.delete(browserRewriteCache.keys().next().value);
      browserRewriteCache.set(ckey, parsed);
    }
    return parsed;
  }

  async function browserCloudRag(query, items, promptPair, model, timeoutMs) {
    const sig = (items || []).slice(0, 4).map(m => m.id).join(',');
    const ckey = `${model}::${query.trim().toLowerCase()}::${sig}`;
    if (browserRagCache.has(ckey)) {
      return { ...browserRagCache.get(ckey), cached: true, cloud_ms: 0.5 };
    }
    const t0 = performance.now();
    const answer = await schoolCloudPost(
      model,
      [
        { role: 'system', content: promptPair.system },
        { role: 'user', content: promptPair.user }
      ],
      420,
      0.25,
      timeoutMs
    );
    const out = {
      answer: answer.slice(0, 12000),
      model,
      cloud_ms: Math.round((performance.now() - t0) * 10) / 10,
      cached: false
    };
    if (browserRagCache.size >= 128) browserRagCache.delete(browserRagCache.keys().next().value);
    browserRagCache.set(ckey, out);
    return out;
  }

  // Chinese localization dictionaries for Genres, Countries, Directors, and Iconic Titles
  const EN_TO_ZH_COUNTRY = {
    'United States': '美国', 'United Kingdom': '英国', 'France': '法国', 'Japan': '日本',
    'Germany': '德国', 'Italy': '意大利', 'India': '印度', 'Canada': '加拿大',
    'Hong Kong': '中国香港', 'South Korea': '韩国', 'Spain': '西班牙', 'Australia': '澳大利亚',
    'China': '中国', "People's Republic of China": '中国', 'Soviet Union': '苏联', 'Russia': '俄罗斯',
    'Sweden': '瑞典', 'Mexico': '墨西哥', 'Denmark': '丹麦', 'Poland': '波兰',
    'Netherlands': '荷兰', 'Belgium': '比利时', 'Switzerland': '瑞士', 'Austria': '奥地利',
    'Ireland': '爱尔兰', 'Taiwan': '中国台湾', 'Brazil': '巴西', 'Argentina': '阿根廷',
    'Norway': '挪威', 'Finland': '芬兰', 'Iran': '伊朗', 'Turkey': '土耳其',
    'Czech Republic': '捷克', 'Czechoslovakia': '捷克斯洛伐克', 'Hungary': '匈牙利',
    'New Zealand': '新西兰', 'Thailand': '泰国', 'Philippines': '菲律宾', 'Israel': '以色列',
    'West Germany': '西德', 'Greece': '希腊', 'Portugal': '葡萄牙', 'Romania': '罗马尼亚',
    'Indonesia': '印度尼西亚', 'Egypt': '埃及', 'South Africa': '南非', 'Chile': '智利'
  };

  const EN_TO_ZH_GENRE = {
    'drama': '剧情', 'comedy': '喜剧', 'action': '动作', 'thriller': '惊悚',
    'romance': '爱情', 'horror': '恐怖', 'crime': '犯罪', 'documentary': '纪录片',
    'science fiction': '科幻', 'adventure': '冒险', 'fantasy': '奇幻', 'mystery': '悬疑',
    'animated': '动画', 'animation': '动画', 'war': '战争', 'western': '西部',
    'musical': '音乐歌舞', 'family': '家庭', 'biographical': '传记', 'historical': '历史',
    'film noir': '黑色电影', 'silent': '默片', 'sports': '体育', 'martial arts': '武侠/功夫',
    'comedy drama': '喜剧剧情', 'romantic comedy': '爱情喜剧', 'psychological thriller': '心理惊悚',
    'action thriller': '动作惊悚', 'crime thriller': '犯罪惊悚', 'sci-fi': '科幻',
    'film based on literature': '文学改编', 'film based on a novel': '小说改编',
    'teen': '青春', 'coming-of-age': '成长', 'slasher': '砍杀恐怖', 'superhero': '超级英雄',
    'spy': '谍战', 'heist': '劫案', 'melodrama': '通俗剧', 'satire': '讽刺',
    'disaster': '灾难', 'gangster': '黑帮', 'police procedural': '警匪', 'anime': '日本动画',
    'independent': '独立电影', 'black-and-white': '黑白片', 'LGBT-related': '多元题材'
  };

  const EN_TO_ZH_TITLE = {
    'the blue angel': '蓝天使', 'inception': '盗梦空间', 'interstellar': '星际穿越',
    'the dark knight': '黑暗骑士', 'farewell my concubine': '霸王别姬',
    'in the mood for love': '花样年华', 'chungking express': '重庆森林',
    'spirited away': '千与千寻', 'my neighbor totoro': '龙猫', "howl's moving castle": '哈尔的移动城堡',
    'princess mononoke': '幽灵公主', 'the shawshank redemption': '肖申克的救赎',
    'the godfather': '教父', 'titanic': '泰坦尼克号', 'the matrix': '黑客帝国',
    'parasite': '寄生虫', 'fight club': '搏击俱乐部', 'the truman show': '楚门的世界',
    'forrest gump': '阿甘正传', "schindler's list": '辛德勒的名单', 'coco': '寻梦环游记',
    'infernal affairs': '无间道', 'crouching tiger, hidden dragon': '卧虎藏龙',
    'blade runner': '银翼杀手', '2001: a space odyssey': '2001太空漫游',
    'mulholland drive': '穆赫兰道', 'citizen kane': '公民凯恩', 'casablanca': '卡萨布兰卡',
    'roman holiday': '罗马假日', 'cinema paradiso': '天堂电影院', 'the legend of 1900': '海上钢琴师',
    'to live': '活着', 'let the bullets fly': '让子弹飞', 'your name': '你的名字',
    'seven samurai': '七武士', 'rashomon': '罗生门', 'tokyo story': '东京物语',
    'la la land': '爱乐之城', 'everything everywhere all at once': '瞬息全宇宙',
    'oppenheimer': '奥本海默', 'dune': '沙丘', 'arrival': '降临', 'wall-e': '机器人总动员',
    'pulp fiction': '低俗小说', 'the silence of the lambs': '沉默的羔羊', 'the shining': '闪灵',
    'tangled': '魔发奇缘', 'the expendables': '敢死队', '12 angry men': '十二怒汉',
    'psycho': '惊魂记', 'vertigo': '迷魂记', 'rear window': '后窗', 'se7en': '七宗罪',
    'shutter island': '禁闭岛', 'gone girl': '消失的爱人', 'whiplash': '爆裂鼓手',
    'the grand budapest hotel': '布达佩斯大饭店', 'memories of murder': '杀人回忆',
    'oldboy': '老男孩', 'train to busan': '釜山行', 'shoplifters': '小偷家族'
  };

  const EN_TO_ZH_DIRECTOR = {
    'christopher nolan': '克里斯托弗·诺兰', 'wong kar-wai': '王家卫',
    'hayao miyazaki': '宫崎骏', 'akira kurosawa': '黑泽明', 'alfred hitchcock': '希区柯克',
    'stanley kubrick': '库布里克', 'steven spielberg': '斯皮尔伯格',
    'quentin tarantino': '昆汀·塔伦蒂诺', 'bong joon-ho': '奉俊昊',
    'park chan-wook': '朴赞郁', 'ang lee': '李安', 'zhang yimou': '张艺谋',
    'chen kaige': '陈凯歌', 'hou hsiao-hsien': '侯孝贤', 'edward yang': '杨德昌',
    'johnnie to': '杜琪峰', 'stephen chow': '周星驰', 'denis villeneuve': '丹尼斯·维伦纽瓦',
    'wes anderson': '韦斯·安德森', 'david fincher': '大卫·芬奇',
    'martin scorsese': '马丁·斯科塞斯', 'francis ford coppola': '科波拉',
    'james cameron': '詹姆斯·卡梅隆', 'ridley scott': '雷德利·斯科特',
    'hirokazu kore-eda': '是枝裕和', 'makoto shinkai': '新海诚', 'satoshi kon': '今敏'
  };

  function zhCountry(c) {
    if (!c) return '地区未知';
    return c.split(',').map(part => {
      const p = part.trim();
      return EN_TO_ZH_COUNTRY[p] || p;
    }).filter(Boolean).join(' / ');
  }

  function zhGenre(g) {
    if (!g) return '';
    const low = g.toLowerCase();
    return EN_TO_ZH_GENRE[low] || g;
  }

  function zhDirector(d) {
    if (!d) return '';
    const zh = EN_TO_ZH_DIRECTOR[d.toLowerCase()];
    return zh ? `${zh} (${d})` : d;
  }

  function displayTitle(movie) {
    const zh = movie.title_zh || EN_TO_ZH_TITLE[(movie.title || '').toLowerCase()];
    return (zh && zh !== movie.title) ? `${zh} · ${movie.title}` : movie.title;
  }

  function zhSummaryLine(movie) {
    const yr = movie.year ? `${movie.year} 年` : '';
    const ct = zhCountry(movie.country);
    const gs = (movie.genres || []).slice(0, 2).map(zhGenre).join(' / ');
    const dir = (movie.directors && movie.directors.length) ? `导演：${zhDirector(movie.directors[0])}` : '';
    return [yr, ct !== '地区未知' ? ct : '', gs, dir].filter(Boolean).join(' · ');
  }

  // Genre-based cinema art poster palettes (Criterion / A24 aesthetic)
  const PALETTES = [
    ['#1d2d44', '#3e5c76', '#e5b869'], // sci-fi / drama
    ['#2b1d28', '#5e2c3e', '#f2a65a'], // romance / drama
    ['#152822', '#265347', '#d8b467'], // mystery / noir
    ['#2d2219', '#6e472b', '#f4d38c'], // historical / war
    ['#1c1b33', '#3b376b', '#d97757'], // fantasy / animated
    ['#261717', '#5c2323', '#e09f3e'], // thriller / horror
  ];

  function pickPalette(movie) {
    const g = (movie.genres || []).join(' ').toLowerCase();
    if (/sci|space|cyber/.test(g)) return PALETTES[0];
    if (/roman|music/.test(g)) return PALETTES[1];
    if (/myster|noir|crime|detect/.test(g)) return PALETTES[2];
    if (/war|histor|biograph|west/.test(g)) return PALETTES[3];
    if (/fantas|animat|advent|family/.test(g)) return PALETTES[4];
    if (/horror|thrill|action/.test(g)) return PALETTES[5];
    let h = 0;
    for (let i = 0; i < (movie.title || '').length; i++) h = (h * 31 + movie.title.charCodeAt(i)) % PALETTES.length;
    return PALETTES[Math.abs(h) % PALETTES.length];
  }

  // Lazy Wikipedia poster loader with IntersectionObserver + in-memory cache
  const posterObserver = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target;
          posterObserver.unobserve(img);
          loadWikiPoster(img);
        }
      }, { rootMargin: '120px' })
    : null;

  async function loadWikiPoster(img) {
    const wikiUrl = img.dataset.wiki;
    if (!wikiUrl || !wikiUrl.includes('/wiki/')) return;
    const slug = wikiUrl.split('/wiki/')[1].split('#')[0].split('?')[0];
    if (!slug) return;

    function onImgLoaded() {
      img.classList.add('loaded');
      const art = img.parentElement && img.parentElement.querySelector('.poster-art');
      if (art) art.style.opacity = '0';
    }

    if (posterCache.has(slug)) {
      const cached = posterCache.get(slug);
      if (cached) {
        img.src = cached;
        img.onload = onImgLoaded;
      }
      return;
    }

    try {
      const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`, {
        headers: { 'Accept': 'application/json' }
      });
      if (!resp.ok) {
        posterCache.set(slug, null);
        return;
      }
      const data = await resp.json();
      const thumb = data.thumbnail && data.thumbnail.source;
      posterCache.set(slug, thumb || null);
      if (thumb) {
        img.src = thumb;
        img.onload = onImgLoaded;
      }
    } catch {
      posterCache.set(slug, null);
    }
  }

  // Safe Markdown -> DOM renderer (escapes HTML completely, supports headings, bold, inline code, lists, tables)
  function renderSafeMarkdown(text) {
    const container = document.createElement('div');
    container.className = 'reply-body';
    const lines = String(text || '').split('\n');
    let i = 0;

    function appendInline(parent, str) {
      const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let lastIdx = 0;
      let m;
      while ((m = tokenRe.exec(str)) !== null) {
        if (m.index > lastIdx) parent.append(document.createTextNode(str.slice(lastIdx, m.index)));
        const tok = m[0];
        if (tok.startsWith('**')) {
          const b = document.createElement('strong');
          b.textContent = tok.slice(2, -2);
          parent.append(b);
        } else if (tok.startsWith('`')) {
          const c = document.createElement('code');
          c.style.cssText = 'font-family:var(--mono);background:var(--bg-soft);padding:1px 5px;border-radius:4px;font-size:12px;';
          c.textContent = tok.slice(1, -1);
          parent.append(c);
        }
        lastIdx = m.index + tok.length;
      }
      if (lastIdx < str.length) parent.append(document.createTextNode(str.slice(lastIdx)));
    }

    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) { i++; continue; }

      // Table
      if (line.startsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
        const tbl = document.createElement('table');
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          rows.push(lines[i].trim().slice(1, -1).split('|').map(c => c.trim()));
          i++;
        }
        rows.forEach((cells, rIdx) => {
          if (rIdx === 1 && cells.every(c => /^[-:\s]+$/.test(c))) return;
          const tr = document.createElement('tr');
          cells.forEach(cell => {
            const el = document.createElement(rIdx === 0 ? 'th' : 'td');
            appendInline(el, cell);
            tr.append(el);
          });
          tbl.append(tr);
        });
        container.append(tbl);
        continue;
      }

      // Heading
      if (line.startsWith('### ')) {
        const h = document.createElement('h3');
        appendInline(h, line.slice(4));
        container.append(h);
        i++;
        continue;
      }

      // Unordered list
      if (/^[-•]\s+/.test(line)) {
        const ul = document.createElement('ul');
        while (i < lines.length && /^[-•]\s+/.test(lines[i].trim())) {
          const li = document.createElement('li');
          appendInline(li, lines[i].trim().replace(/^[-•]\s+/, ''));
          ul.append(li);
          i++;
        }
        container.append(ul);
        continue;
      }

      // Ordered list (handles blank lines between items cleanly)
      if (/^\d+\.\s+/.test(line)) {
        const ol = document.createElement('ol');
        const firstNum = parseInt(line.match(/^(\d+)\./)[1], 10);
        if (firstNum > 1) ol.start = firstNum;
        while (i < lines.length) {
          const cur = lines[i].trim();
          if (/^\d+\.\s+/.test(cur)) {
            const li = document.createElement('li');
            appendInline(li, cur.replace(/^\d+\.\s+/, ''));
            ol.append(li);
            i++;
          } else if (!cur && i + 1 < lines.length && /^\d+\.\s+/.test(lines[i + 1].trim())) {
            i++;
          } else {
            break;
          }
        }
        container.append(ol);
        continue;
      }

      const p = document.createElement('p');
      appendInline(p, line);
      container.append(p);
      i++;
    }
    return container;
  }

  function createPosterBox(movie, large = false) {
    const box = document.createElement('div');
    box.className = 'poster-box';
    if (large) box.style.width = '160px';
    const [c1, c2, accent] = pickPalette(movie);

    const art = document.createElement('div');
    art.className = 'poster-art';
    art.style.background = `linear-gradient(155deg, ${c1} 0%, ${c2} 72%, ${c1} 100%)`;
    art.style.borderTop = `3px solid ${accent}`;

    const yr = document.createElement('div');
    yr.className = 'poster-year';
    yr.textContent = movie.year || 'FILM';

    const ttl = document.createElement('div');
    ttl.className = 'poster-title-art';
    ttl.textContent = movie.title;

    const dir = document.createElement('div');
    dir.className = 'poster-dir-art';
    dir.textContent = (movie.directors && movie.directors[0]) || movie.country || 'Cinema Archive';

    art.append(yr, ttl, dir);
    box.append(art);

    if (movie.rating != null) {
      const rb = document.createElement('div');
      rb.className = 'poster-rating-badge';
      rb.textContent = `★ ${movie.rating.toFixed(1)}`;
      box.append(rb);
    }

    if (movie.url) {
      const img = document.createElement('img');
      img.className = 'poster-img';
      img.alt = `${movie.title} poster`;
      img.loading = 'lazy';
      img.dataset.wiki = movie.url;
      box.append(img);
      if (posterObserver) posterObserver.observe(img);
      else loadWikiPoster(img);
    }
    return box;
  }

  function createMovieCard(movie) {
    const card = document.createElement('article');
    card.className = 'movie-card';

    const poster = createPosterBox(movie);
    poster.onclick = () => openDetailModal(movie);

    const info = document.createElement('div');
    info.className = 'movie-info';

    const trow = document.createElement('div');
    trow.className = 'movie-title-row';
    const h3 = document.createElement('h3');
    h3.className = 'movie-title';
    h3.textContent = displayTitle(movie);
    h3.onclick = () => openDetailModal(movie);
    const qid = document.createElement('span');
    qid.className = 'qid-tag';
    qid.textContent = movie.id;
    trow.append(h3, qid);

    const sub = document.createElement('div');
    sub.className = 'movie-sub';
    sub.textContent = [
      movie.year ? `${movie.year} 年` : '年份未知',
      zhCountry(movie.country),
      movie.minutes ? `${movie.minutes} 分钟` : null,
      movie.rating != null ? `TMDb ${movie.rating.toFixed(1)} (${(movie.votes || 0).toLocaleString()}票)` : '评分缺失'
    ].filter(Boolean).join(' · ');

    const dir = document.createElement('div');
    dir.className = 'movie-dir';
    dir.textContent = `导演：${(movie.directors && movie.directors.length) ? movie.directors.map(zhDirector).join('、') : '资料缺失'}`;

    info.append(trow, sub, dir);

    if (movie.similarity_reason) {
      const simB = document.createElement('div');
      simB.className = 'sim-badge';
      simB.textContent = `🔗 相似依据：${movie.similarity_reason}`;
      info.append(simB);
    }

    if (movie.awards) {
      const aw = document.createElement('div');
      aw.className = 'award-pill';
      aw.title = movie.awards;
      aw.textContent = `🏆 获奖：${movie.awards}`;
      info.append(aw);
    }

    if (movie.plot_zh) {
      const zhPlot = document.createElement('div');
      zhPlot.className = 'movie-plot';
      zhPlot.style.color = 'var(--ink)';
      zhPlot.textContent = movie.plot_zh;
      info.append(zhPlot);
    } else {
      const zhLine = document.createElement('div');
      zhLine.style.cssText = 'font-size:11.5px;color:var(--gold);margin-bottom:3px;';
      zhLine.textContent = zhSummaryLine(movie);
      info.append(zhLine);

      const plot = document.createElement('div');
      plot.className = 'movie-plot';
      plot.textContent = movie.plot || '';
      info.append(plot);
    }

    const tags = document.createElement('div');
    tags.className = 'tag-row';
    [...(movie.genres || []).slice(0, 3).map(zhGenre), ...(movie.cast || []).slice(0, 2)].forEach(t => {
      const s = document.createElement('span');
      s.className = 'mini-tag';
      s.textContent = t;
      tags.append(s);
    });
    info.append(tags);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const btnDetail = document.createElement('button');
    btnDetail.type = 'button';
    btnDetail.className = 'btn btn-sm';
    btnDetail.textContent = '详情';
    btnDetail.onclick = () => openDetailModal(movie);

    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'btn btn-sm';
    const syncSaveText = () => {
      const saved = shortlist.has(movie.id);
      btnSave.textContent = saved ? '✓ 已收藏' : '＋ 存片单';
      btnSave.style.borderColor = saved ? 'var(--gold)' : '';
      btnSave.style.color = saved ? 'var(--gold)' : '';
    };
    syncSaveText();
    btnSave.onclick = () => {
      if (shortlist.has(movie.id)) shortlist.delete(movie.id);
      else shortlist.set(movie.id, movie);
      syncSaveText();
      updateShortlistCount();
    };
    const btnSimilar = document.createElement('button');
    btnSimilar.type = 'button';
    btnSimilar.className = 'btn btn-sm';
    btnSimilar.style.borderColor = 'var(--line-strong)';
    btnSimilar.style.color = 'var(--gold)';
    btnSimilar.textContent = '＋ 类似';
    btnSimilar.title = '推荐 3 部风格/题材/导演相似的影片';
    btnSimilar.onclick = () => requestSimilar(movie);

    actions.append(btnDetail, btnSimilar, btnSave);

    if (movie.zh_url) {
      const a = document.createElement('a');
      a.className = 'card-link';
      a.href = movie.zh_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '中文维基 ↗';
      actions.append(a);
    } else if (movie.url) {
      const a = document.createElement('a');
      a.className = 'card-link';
      a.href = movie.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Wiki ↗';
      actions.append(a);
    }
    if (movie.imdb) {
      const a = document.createElement('a');
      a.className = 'card-link';
      a.href = `https://www.imdb.com/title/${encodeURIComponent(movie.imdb)}/`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'IMDb ↗';
      actions.append(a);
    }

    info.append(actions);
    card.append(poster, info);
    return card;
  }

  function updateShortlistCount() {
    $('shortlistCount').textContent = String(shortlist.size);
  }

  function openDetailModal(movie) {
    const body = $('detailBody');
    body.replaceChildren();
    const grid = document.createElement('div');
    grid.className = 'detail-grid';
    grid.append(createPosterBox(movie, true));

    const right = document.createElement('div');
    const h = document.createElement('h2');
    h.textContent = `${displayTitle(movie)} (${movie.year || '未知'})`;
    const meta = document.createElement('p');
    meta.className = 'modal-sub';
    meta.textContent = [
      `Wikidata: ${movie.id}`,
      zhCountry(movie.country),
      movie.minutes ? `${movie.minutes} 分钟` : null,
      movie.rating != null ? `TMDb ${movie.rating.toFixed(1)}/10 (${(movie.votes || 0).toLocaleString()}票)` : '评分缺失'
    ].filter(Boolean).join(' · ');

    const rows = [
      ['国别', movie.region || '国外'],
      ['导演', (movie.directors || []).map(zhDirector).join('、') || '资料缺失'],
      ['主演', (movie.cast || []).join('、') || '资料缺失'],
      ['类型', (movie.genres || []).map(zhGenre).join(' / ') || '资料缺失'],
      ['获奖记录', movie.awards || '索引快照中暂无获奖条目'],
    ];
    if (movie.plot_zh) rows.push(['中文剧情简介（维基百科）', movie.plot_zh]);
    rows.push(['原始英文剧情（开启云端 RAG 可自动中文精析）', movie.plot || '无']);
    right.append(h, meta);
    rows.forEach(([k, v]) => {
      const p = document.createElement('p');
      p.style.cssText = 'margin:6px 0;font-size:13px;line-height:1.6;';
      const strong = document.createElement('strong');
      strong.style.color = 'var(--gold)';
      strong.textContent = k + '：';
      p.append(strong, document.createTextNode(v));
      right.append(p);
    });

    const links = document.createElement('div');
    links.className = 'chip-bar';
    if (movie.url) {
      const a = document.createElement('a');
      a.className = 'btn btn-sm';
      a.href = movie.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = 'Wikipedia 原条目 ↗';
      links.append(a);
    }
    if (movie.imdb) {
      const a = document.createElement('a');
      a.className = 'btn btn-sm';
      a.href = `https://www.imdb.com/title/${encodeURIComponent(movie.imdb)}/`;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = `IMDb (${movie.imdb}) ↗`;
      links.append(a);
    }
    if (movie.tmdb) {
      const a = document.createElement('a');
      a.className = 'btn btn-sm';
      a.href = `https://www.themoviedb.org/movie/${encodeURIComponent(movie.tmdb)}`;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = 'TMDb ↗';
      links.append(a);
    }
    right.append(links);
    grid.append(right);
    body.append(grid);
    $('detailModal').showModal();
  }

  function renderShortlistModal() {
    const box = $('shortlistBody');
    box.replaceChildren();
    if (!shortlist.size) {
      const p = document.createElement('p');
      p.className = 'modal-sub';
      p.textContent = '还没收藏电影呢，点任意影片卡片上的「＋ 存片单」就能加进来，随时可以导出分享。';
      box.append(p);
      return;
    }
    for (const m of shortlist.values()) {
      const row = document.createElement('div');
      row.className = 'shortlist-item';
      const left = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = `《${m.title}》(${m.year || '?'}) [${m.id}]`;
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:12px;color:var(--muted);';
      sub.textContent = `导演：${(m.directors || []).join(', ') || '未知'} · ${m.country || '未知'} · TMDb ${m.rating != null ? m.rating.toFixed(1) : 'N/A'}`;
      left.append(strong, sub);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-sm';
      rm.textContent = '移除';
      rm.onclick = () => { shortlist.delete(m.id); updateShortlistCount(); renderShortlistModal(); };
      row.append(left, rm);
      box.append(row);
    }
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportShortlistMarkdown() {
    if (!shortlist.size) return;
    const lines = [
      '# 片刻 CineCurator — 我的电影片单',
      '',
      `> 导出时间：${new Date().toLocaleString()} · 共 ${shortlist.size} 部已验证影片 · 数据来源：MoviePlotEmbeddingsDataset (CC BY-NC 4.0)`,
      '',
      '| # | 片名 | 年份 | 国家/地区 | 导演 | TMDb 评分 | 溯源 ID |',
      '| --- | --- | --- | --- | --- | --- | --- |'
    ];
    let idx = 1;
    for (const m of shortlist.values()) {
      lines.push(`| ${idx++} | ${m.title} | ${m.year || '-'} | ${m.country || '-'} | ${(m.directors || []).join(', ') || '-'} | ${m.rating != null ? m.rating.toFixed(1) : '-'} | ${m.id} |`);
    }
    lines.push('', '## 影片详情与剧情参考', '');
    for (const m of shortlist.values()) {
      lines.push(`### ${m.title} (${m.year || '?'}) [${m.id}]`);
      lines.push(`- **导演**：${(m.directors || []).join(', ') || '未知'}`);
      lines.push(`- **主演**：${(m.cast || []).join(', ') || '未知'}`);
      lines.push(`- **类型**：${(m.genres || []).join(', ') || '未知'}`);
      if (m.awards) lines.push(`- **获奖**：${m.awards}`);
      if (m.url) lines.push(`- **Wikipedia**：${m.url}`);
      if (m.imdb) lines.push(`- **IMDb**：https://www.imdb.com/title/${m.imdb}/`);
      lines.push(`- **剧情摘录**：${m.plot}`, '');
    }
    downloadFile('cinecurator_shortlist.md', lines.join('\n'), 'text/markdown;charset=utf-8');
  }

  function updateSlotPills(slots) {
    const el = $('slotList');
    el.replaceChildren();
    const entries = [];
    if (slots) {
      if (slots.region) entries.push(`国别: ${slots.region}`);
      if (slots.mapped_title) entries.push(`片名: ${EN_TO_ZH_TITLE[slots.mapped_title.toLowerCase()] || slots.mapped_title}`);
      if (slots.country) entries.push(`地区: ${zhCountry(slots.country)}`);
      if (slots.genre) entries.push(`类型: ${zhGenre(slots.genre)}`);
      if (slots.director) entries.push(`导演: ${zhDirector(slots.director)}`);
      if (slots.actor) entries.push(`演员: ${slots.actor}`);
      if (slots.year_min || slots.year_max) entries.push(`年份: ${slots.year_min || ''}–${slots.year_max || ''}`);
      if (slots.min_rating) entries.push(`评分 ≥ ${slots.min_rating}`);
      if (slots.awards_only) entries.push('🏆 含获奖记录');
      if (slots.exclude_region) entries.push(`🚫 排除国别: ${slots.exclude_region}`);
      if (slots.exclude_genres && slots.exclude_genres.length) entries.push(`🚫 排除类型: ${slots.exclude_genres.map(zhGenre).join('/')}`);
      if (slots.exclude_countries && slots.exclude_countries.length) entries.push(`🚫 排除地区: ${slots.exclude_countries.map(zhCountry).join('/')}`);
      if (slots.expanded_terms && slots.expanded_terms.length) entries.push(`主题词: ${slots.expanded_terms.slice(0, 3).join('/')}`);
    }
    if (!entries.length) {
      const span = document.createElement('span');
      span.className = 'slot-empty';
      span.textContent = '还没加条件，直接聊聊你想看什么就行';
      el.append(span);
      return;
    }
    entries.forEach(txt => {
      const chip = document.createElement('span');
      chip.className = 'slot-chip';
      chip.textContent = txt;
      el.append(chip);
    });
  }

  function getUiFilters() {
    const f = {};
    const region = $('fRegion') ? $('fRegion').value : '';
    const genre = $('fGenre').value;
    const country = $('fCountry').value;
    const director = $('fDirector').value.trim();
    const actor = $('fActor').value.trim();
    const yMin = $('fYearMin').value.trim();
    const yMax = $('fYearMax').value.trim();
    const rating = $('fRating').value.trim();
    const awards = $('fAwards').checked;
    if (region) f.region = region;
    if (genre) f.genre = genre;
    if (country) f.country = country;
    if (director) f.director = director;
    if (actor) f.actor = actor;
    if (yMin) f.year_min = yMin;
    if (yMax) f.year_max = yMax;
    if (rating) f.min_rating = rating;
    if (awards) f.awards_only = true;
    return Object.keys(f).length ? f : null;
  }

  function clearUiFilters() {
    if ($('fRegion')) $('fRegion').value = '';
    $('fGenre').value = '';
    $('fCountry').value = '';
    $('fDirector').value = '';
    $('fActor').value = '';
    $('fYearMin').value = '';
    $('fYearMax').value = '';
    $('fRating').value = '';
    $('fAwards').checked = false;
  }

  function routeMeta(route) {
    switch (route) {
      case 'rag_cloud': return ['✨ AI 推荐', 'route-cloud'];
      case 'degraded_local': return ['⚡ 网络波动 · 已切换片库直搜', 'route-degraded'];
      case 'clarify': return ['💬 想多了解一点', 'route-clarify'];
      case 'security_refusal': return ['🛡️ 提示', 'route-security'];
      case 'no_evidence': return ['📭 暂未找到', 'route-empty'];
      case 'context_compare': return ['🔄 影片对比', 'route-cloud'];
      case 'self_intro': return ['👋 你好', 'route-clarify'];
      case 'meta_qa': return ['ℹ️ 关于片刻', 'route-clarify'];
      case 'off_topic': return ['🎬 专注电影', 'route-empty'];
      case 'context_detail': return ['📄 影片详情', 'route-cloud'];
      case 'similar': return ['✨ 相似推荐', 'route-cloud'];
      case 'reset': return ['🧹 新对话', 'route-empty'];
      default: return ['📚 片库直搜', 'route-local'];
    }
  }

  async function requestSimilar(movie) {
    if (!movie || !movie.id) return;
    appendUserBubble(`＋ 推荐与《${displayTitle(movie)}》类似的电影`);
    $('sendBtn').disabled = true;
    try {
      const excl = [...seenMovieIds];
      let data;
      if (useServerApi) {
        const resp = await fetch('/api/similar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ movie_id: movie.id, exclude_ids: excl, limit: 3 })
        });
        data = await resp.json();
      } else {
        data = browserEngine.findSimilar(movie.id, excl, 3);
      }
      appendBotMessage(data);
    } catch (err) {
      appendBotMessage({
        route: 'error',
        reply: `相似影片推荐异常：${err.message || '请稍后再试'}`,
        items: []
      });
    } finally {
      $('sendBtn').disabled = false;
    }
  }

  function appendUserBubble(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    wrap.append(b);
    $('messages').append(wrap);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  function appendBotMessage(data) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-bot';
    const b = document.createElement('div');
    b.className = 'bubble';

    // Top meta bar
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const [badgeText, badgeCls] = routeMeta(data.route);
    const badge = document.createElement('span');
    badge.className = `route-badge ${badgeCls}`;
    badge.textContent = badgeText;
    const lat = document.createElement('span');
    lat.className = 'latency-tag';
    lat.textContent = data.latency_ms != null ? `${data.latency_ms} ms` : '';
    meta.append(badge, lat);
    b.append(meta);

    // Reply markdown
    b.append(renderSafeMarkdown(data.reply || data.message || ''));

    // Web grounding sources (Gemini)
    if (data.sources && data.sources.length) {
      const ul = document.createElement('ul');
      ul.className = 'web-sources';
      data.sources.forEach(s => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = `联网溯源：${s.title || s.url}`;
        li.append(a);
        ul.append(li);
      });
      b.append(ul);
    }

    // Movie poster cards + clean '+' expansion card
    if (data.items && data.items.length) {
      const grid = document.createElement('div');
      grid.className = 'movie-grid';
      data.items.forEach(m => {
        seenMovieIds.add(m.id);
        grid.append(createMovieCard(m));
      });

      // Add tactile '+' expansion card for similar movies & on-demand more results
      if (data.route === 'rag_local' || data.route === 'rag_cloud' || data.route === 'degraded_local' || data.route === 'similar') {
        const seedMovie = data.items[0];
        const plusCard = document.createElement('div');
        plusCard.className = 'plus-card';

        const circle = document.createElement('button');
        circle.type = 'button';
        circle.className = 'plus-circle';
        circle.textContent = '+';
        circle.title = '推荐更多类似电影';
        circle.onclick = () => requestSimilar(seedMovie);

        const title = document.createElement('div');
        title.className = 'plus-card-title';
        title.textContent = '探索更多类似电影';

        const sub = document.createElement('div');
        sub.className = 'plus-card-sub';
        sub.textContent = `点击「＋」基于《${seedMovie.title_zh || seedMovie.title}》的导演、题材与剧情推荐 3 部同风格佳作`;

        const btns = document.createElement('div');
        btns.className = 'plus-card-btns';

        const simBtn = document.createElement('button');
        simBtn.type = 'button';
        simBtn.className = 'btn btn-sm btn-gold';
        simBtn.textContent = '＋ 推荐类似';
        simBtn.onclick = () => requestSimilar(seedMovie);
        btns.append(simBtn);

        if (data.has_more && data.route !== 'similar') {
          const moreBtn = document.createElement('button');
          moreBtn.type = 'button';
          moreBtn.className = 'btn btn-sm';
          const rem = Math.max(0, (data.total || 0) - (data.next_offset || data.items.length));
          moreBtn.textContent = `展开更多（余 ${rem.toLocaleString()} 部）`;
          moreBtn.onclick = () => sendMessage(lastQuery, { offset: data.next_offset || (lastOffset + data.items.length), silentUser: true });
          btns.append(moreBtn);
        }

        plusCard.append(circle, title, sub, btns);
        grid.append(plusCard);
      }

      b.append(grid);
    }

    // Actionable suggestions / relaxation fallback / pagination chips
    const chips = document.createElement('div');
    chips.className = 'chip-bar';

    if (data.relaxations && data.relaxations.length) {
      data.relaxations.forEach(rel => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip-btn';
        btn.textContent = `🔧 ${rel.label}（约 ${rel.estimated_total.toLocaleString()} 部）`;
        btn.onclick = () => {
          if (rel.drop_key === 'min_rating') $('fRating').value = '';
          if (rel.drop_key === 'awards_only') $('fAwards').checked = false;
          if (rel.drop_key === 'year_min' || rel.drop_key === 'year_max') { $('fYearMin').value = ''; $('fYearMax').value = ''; }
          if (rel.drop_key === 'country') $('fCountry').value = '';
          if (rel.drop_key === 'genre') $('fGenre').value = '';
          if (rel.drop_key === 'director') $('fDirector').value = '';
          if (rel.drop_key === 'actor') $('fActor').value = '';
          sendMessage(lastQuery || 'movie', { forceFilters: getUiFilters() || {} });
        };
        chips.append(btn);
      });
    } else if (data.suggestions && data.suggestions.length) {
      data.suggestions.forEach(s => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip-btn';
        btn.textContent = s;
        btn.onclick = () => sendMessage(s);
        chips.append(btn);
      });
    } else if (data.items && data.items.length >= 2 && (data.route === 'rag_local' || data.route === 'rag_cloud' || data.route === 'degraded_local')) {
      const quickFollowups = ['对比前两部', '详细介绍第 1 部', '只要 2000 年以后', '只要评分 7.5 分以上'];
      quickFollowups.forEach(s => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip-btn';
        btn.textContent = s;
        btn.onclick = () => sendMessage(s);
        chips.append(btn);
      });
    }

    if (chips.childElementCount) b.append(chips);

    // Collapsible retrieval trace
    if (data.trace && data.trace.length) {
      const det = document.createElement('details');
      det.className = 'trace-details';
      const sum = document.createElement('summary');
      sum.textContent = `查看检索过程（${data.trace.length} 步）`;
      const steps = document.createElement('div');
      steps.className = 'trace-steps';
      data.trace.forEach((t, idx) => {
        const item = document.createElement('div');
        item.className = 'trace-step';
        const st = document.createElement('strong');
        st.textContent = `${idx + 1}. ${t.step}`;
        item.append(st, document.createTextNode(`：${t.detail}`));
        steps.append(item);
      });
      det.append(sum, steps);
      b.append(det);
    }

    wrap.append(b);
    $('messages').append(wrap);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  async function sendMessageStream(q, uiFilters) {
    const resp = await fetch('/api/chat_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: q,
        session_id: SESSION_ID,
        filters: uiFilters,
        offset: 0
      })
    });
    if (!resp.ok || !resp.body) throw new Error('流式连接失败');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let liveWrap = null, liveBody = null, liveBadge = null, liveLat = null, liveTrace = null;
    let accText = '';

    function ensureLiveBubble(cardsData) {
      if (liveWrap) return;
      if (cardsData.slots !== undefined) updateSlotPills(cardsData.slots);
      lastTotal = cardsData.total || 0;
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-bot';
      const b = document.createElement('div');
      b.className = 'bubble';

      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      const badge = document.createElement('span');
      badge.className = 'route-badge route-cloud';
      badge.textContent = '✨ 云端闭卷 RAG · 实时生成中…';
      const lat = document.createElement('span');
      lat.className = 'latency-tag';
      lat.textContent = `片库检索 ${cardsData.latency_ms ?? 0} ms`;
      meta.append(badge, lat);
      b.append(meta);

      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'reply-body';
      bodyDiv.style.whiteSpace = 'pre-wrap';
      bodyDiv.textContent = '正在结合下方已验证片库证据流式生成推荐…';
      b.append(bodyDiv);

      // Render movie cards IMMEDIATELY (0.03s!) while LLM text streams above!
      if (cardsData.items && cardsData.items.length) {
        const grid = document.createElement('div');
        grid.className = 'movie-grid';
        cardsData.items.forEach(m => {
          seenMovieIds.add(m.id);
          grid.append(createMovieCard(m));
        });
        const seedMovie = cardsData.items[0];
        const plusCard = document.createElement('div');
        plusCard.className = 'plus-card';
        const circle = document.createElement('button');
        circle.type = 'button'; circle.className = 'plus-circle'; circle.textContent = '+';
        circle.onclick = () => requestSimilar(seedMovie);
        const title = document.createElement('div');
        title.className = 'plus-card-title'; title.textContent = '探索更多类似电影';
        const sub = document.createElement('div');
        sub.className = 'plus-card-sub';
        sub.textContent = `点击「＋」基于《${seedMovie.title_zh || seedMovie.title}》推荐 3 部同风格佳作`;
        const btns = document.createElement('div');
        btns.className = 'plus-card-btns';
        const simBtn = document.createElement('button');
        simBtn.type = 'button'; simBtn.className = 'btn btn-sm btn-gold'; simBtn.textContent = '＋ 推荐类似';
        simBtn.onclick = () => requestSimilar(seedMovie);
        btns.append(simBtn);
        if (cardsData.has_more) {
          const moreBtn = document.createElement('button');
          moreBtn.type = 'button'; moreBtn.className = 'btn btn-sm';
          const rem = Math.max(0, (cardsData.total || 0) - (cardsData.next_offset || cardsData.items.length));
          moreBtn.textContent = `展开更多（余 ${rem.toLocaleString()} 部）`;
          moreBtn.onclick = () => sendMessage(lastQuery, { offset: cardsData.next_offset || cardsData.items.length, silentUser: true });
          btns.append(moreBtn);
        }
        plusCard.append(circle, title, sub, btns);
        grid.append(plusCard);
        b.append(grid);
      }

      const traceSlot = document.createElement('div');
      b.append(traceSlot);

      wrap.append(b);
      $('messages').append(wrap);
      $('messages').scrollTop = $('messages').scrollHeight;
      liveWrap = wrap; liveBody = bodyDiv; liveBadge = badge; liveLat = lat; liveTrace = traceSlot;
    }

    function renderTraceInto(container, trace, hitId) {
      if (!trace || !trace.length) return;
      const det = document.createElement('details');
      det.className = 'trace-details';
      const sum = document.createElement('summary');
      sum.textContent = `🔎 查看架构决策路由追踪（${trace.length} 步 · 首位命中 ID: ${hitId || '无'}）`;
      const steps = document.createElement('div');
      steps.className = 'trace-steps';
      trace.forEach((t, idx) => {
        const item = document.createElement('div');
        item.className = 'trace-step';
        const st = document.createElement('strong');
        st.textContent = `${idx + 1}. ${t.step}`;
        item.append(st, document.createTextNode(`：${t.detail}`));
        steps.append(item);
      });
      det.append(sum, steps);
      container.replaceChildren(det);
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const block of parts) {
        let evName = 'message', dataStr = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) evName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        const payload = JSON.parse(dataStr);
        if (evName === 'cards') {
          ensureLiveBubble(payload);
        } else if (evName === 'delta') {
          accText += payload.text || '';
          if (liveBody) {
            liveBody.textContent = accText + ' ▌';
            $('messages').scrollTop = $('messages').scrollHeight;
          }
        } else if (evName === 'done') {
          if (!liveWrap) {
            if (payload.slots !== undefined) updateSlotPills(payload.slots);
            lastTotal = payload.total || 0;
            appendBotMessage(payload);
          } else {
            const [bt, bc] = routeMeta(payload.route);
            liveBadge.className = `route-badge ${bc}`;
            liveBadge.textContent = bt;
            liveLat.textContent = `${payload.latency_ms} ms`;
            const mdDom = renderSafeMarkdown(payload.reply || accText);
            liveBody.replaceWith(mdDom);
            liveBody = mdDom;
            renderTraceInto(liveTrace, payload.trace, payload.hit_id);
            $('messages').scrollTop = $('messages').scrollHeight;
          }
        } else if (evName === 'degraded') {
          if (!liveWrap) {
            appendBotMessage(payload);
          } else {
            const [bt, bc] = routeMeta('degraded_local');
            liveBadge.className = `route-badge ${bc}`;
            liveBadge.textContent = bt;
            liveLat.textContent = `${payload.latency_ms} ms`;
            const mdDom = renderSafeMarkdown(payload.reply);
            liveBody.replaceWith(mdDom);
            liveBody = mdDom;
            renderTraceInto(liveTrace, payload.trace, payload.hit_id);
          }
        }
      }
    }
  }

  async function sendMessage(queryText, opts = {}) {
    const q = (queryText || '').trim();
    if (!q) return;
    if (!opts.silentUser) {
      appendUserBubble(q);
      lastQuery = q;
      lastOffset = 0;
    } else {
      lastOffset = opts.offset || 0;
    }

    const uiFilters = opts.forceFilters !== undefined ? opts.forceFilters : getUiFilters();
    const useCloudToggle = !!($('cloudToggle') && $('cloudToggle').checked && (useServerApi ? cloudConfigured : true));
    const fastGuardToggle = !!($('fastGuardToggle') && $('fastGuardToggle').checked);
    const activeModel = getSelectedCloudModel();

    $('sendBtn').disabled = true;
    // Unified cohesive generation with live elapsed timer (works in both local & GitHub Pages cloud RAG)
    let loadingBubble = null;
    let loadingTimer = null;
    if (useCloudToggle && !opts.simulateFailure && lastOffset === 0) {
      const tStart = performance.now();
      loadingBubble = document.createElement('div');
      loadingBubble.className = 'msg msg-bot';
      loadingBubble.innerHTML = `<div class="bubble"><div class="msg-meta"><span class="route-badge route-cloud">✨ 正在为你挑片…</span><span class="latency-tag" id="liveWaitTimer">0.0 s</span></div><div class="reply-body" style="color:var(--muted);">正在翻片库找最合适的几部，马上就好…</div></div>`;
      $('messages').append(loadingBubble);
      $('messages').scrollTop = $('messages').scrollHeight;
      loadingTimer = setInterval(() => {
        const el = loadingBubble && loadingBubble.querySelector('#liveWaitTimer');
        if (el) el.textContent = `${((performance.now() - tStart) / 1000).toFixed(1)} s`;
      }, 100);
    }
    try {
      let data;
      if (useServerApi) {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: q,
            session_id: SESSION_ID,
            filters: uiFilters,
            offset: lastOffset,
            use_cloud: !!useCloudToggle,
            fast_guard: !!fastGuardToggle,
            simulate_cloud_failure: !!opts.simulateFailure
          })
        });
        data = await resp.json();
      } else {
        if (!browserEngine.ready) {
          throw new Error('片库仍在加载解压中，请稍候 1–2 秒再试。');
        }
        if (opts.simulateFailure) {
          const local = browserEngine.chat(q, uiFilters, lastOffset);
          local.route = 'degraded_local';
          local.reply = '【已优雅降级至本地片库模式】演示模式模拟云端 API 超时（504），系统自动回退至浏览器本地 92,374 部全量片库继续服务。\n\n' + local.reply;
          local.trace = [...(local.trace || []), { step: '优雅降级', status: 'degraded', detail: '模拟云端故障，自动降级为浏览器本地检索' }];
          data = local;
        } else if (useCloudToggle) {
          const timeoutMs = fastGuardToggle ? 4500 : 15000;
          data = await browserEngine.chatAsync(q, uiFilters, lastOffset, {
            enabled: true,
            model: activeModel,
            rewriter: (queryStr, hist) => browserCloudRewrite(queryStr, hist, activeModel, timeoutMs),
            caller: (queryStr, items, promptPair) => browserCloudRag(queryStr, items, promptPair, activeModel, timeoutMs)
          });
        } else {
          data = browserEngine.chat(q, uiFilters, lastOffset);
        }
      }
      if (loadingTimer) clearInterval(loadingTimer);
      if (loadingBubble) loadingBubble.remove();
      lastTotal = data.total || 0;
      if (data.slots !== undefined) updateSlotPills(data.slots);
      appendBotMessage(data);
    } catch (err) {
      if (loadingTimer) clearInterval(loadingTimer);
      if (loadingBubble) loadingBubble.remove();
      appendBotMessage({
        route: 'error',
        reply: `请求处理异常：${err.message || '请检查本地服务或网络连接。'}`,
        items: [],
        trace: [{ step: '异常处理', status: 'error', detail: err.message || 'unknown error' }]
      });
    } finally {
      $('sendBtn').disabled = false;
      $('chatInput').focus();
    }
  }

  function populateMeta(meta, modeLabel) {
    $('statusText').textContent = `${meta.records.toLocaleString()} 部电影 · ${modeLabel}`;
    $('statRecords').textContent = meta.records.toLocaleString();
    $('statDirectors').textContent = (meta.with_directors || 34699).toLocaleString();
    $('statAwards').textContent = (meta.with_awards || 4372).toLocaleString();
    $('statYears').textContent = meta.year_range || '1930–2024';

    const fillSelect = (id, list, mapper) => {
      const sel = $(id);
      while (sel.options.length > 1) sel.remove(1);
      (list || []).forEach(v => {
        const o = document.createElement('option');
        o.value = v;
        const zh = mapper(v);
        o.textContent = zh && zh !== v ? `${zh} (${v})` : v;
        sel.append(o);
      });
    };
    fillSelect('fGenre', meta.genres, zhGenre);
    fillSelect('fCountry', meta.countries, zhCountry);
  }

  async function init() {
    // Theme toggle
    $('themeBtn').onclick = () => {
      document.body.classList.toggle('light');
      $('themeBtn').textContent = document.body.classList.contains('light') ? '🌙 深色模式' : '☀️ 浅色模式';
    };

    // Modals
    $('archBtn').onclick = () => $('archModal').showModal();
    $('closeArch').onclick = () => $('archModal').close();
    $('closeDetail').onclick = () => $('detailModal').close();
    $('shortlistBtn').onclick = () => { renderShortlistModal(); $('shortlistModal').showModal(); };
    $('closeShortlist').onclick = () => $('shortlistModal').close();
    $('exportMdBtn').onclick = exportShortlistMarkdown;
    $('exportJsonBtn').onclick = () => {
      if (!shortlist.size) return;
      downloadFile('cinecurator_shortlist.json', JSON.stringify([...shortlist.values()], null, 2), 'application/json;charset=utf-8');
    };

    // Mobile sidebar toggle
    if ($('mobileMenuBtn')) {
      $('mobileMenuBtn').onclick = () => $('sidebar').classList.toggle('mobile-open');
    }

    // Reset session
    $('resetBtn').onclick = async () => {
      seenMovieIds.clear();
      clearUiFilters();
      if (useServerApi) {
        await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: SESSION_ID }) }).catch(() => {});
      } else {
        browserEngine.resetSession();
      }
      updateSlotPills({});
      sendMessage('重置');
    };

    // Chat form submit
    $('chatForm').onsubmit = e => {
      e.preventDefault();
      const val = $('chatInput').value.trim();
      if (!val) return;
      $('chatInput').value = '';
      sendMessage(val);
    };

    // Sidebar filter apply
    $('applyFilterBtn').onclick = () => {
      const f = getUiFilters();
      if (!f && !lastQuery) return;
      const summary = [];
      if (f?.country) summary.push(f.country);
      if (f?.genre) summary.push(f.genre);
      if (f?.director) summary.push(`导演:${f.director}`);
      if (f?.actor) summary.push(`演员:${f.actor}`);
      if (f?.year_min || f?.year_max) summary.push(`${f.year_min || ''}–${f.year_max || ''}`);
      if (f?.min_rating) summary.push(`评分≥${f.min_rating}`);
      if (f?.awards_only) summary.push('获奖影片');
      sendMessage(lastQuery || (summary.length ? `按条件筛选：${summary.join(' · ')}` : 'movie'), { forceFilters: f });
    };
    $('clearFilterBtn').onclick = () => clearUiFilters();

    // Demo scenario buttons
    document.querySelectorAll('[data-demo]').forEach(btn => {
      btn.onclick = () => {
        const q = btn.dataset.demo;
        const simFail = btn.dataset.simfail === '1';
        $('sidebar').classList.remove('mobile-open');
        sendMessage(q, { simulateFailure: simFail });
      };
    });

    // Cloud settings modal (local server edition only)
    if (!STATIC_ONLY && $('settingsBtn')) {
      $('settingsBtn').onclick = () => $('settingsModal').showModal();
      $('closeSettings').onclick = () => $('settingsModal').close();
      $('provider').onchange = () => {
        const isOpenAI = $('provider').value === 'openai';
        $('endpointWrap').classList.toggle('hidden', !isOpenAI);
        $('webSearchWrap').classList.toggle('hidden', isOpenAI);
        $('modelName').value = isOpenAI ? 'gpt-4o-mini' : 'gemini-2.5-flash';
      };
      $('settingsForm').onsubmit = async e => {
        e.preventDefault();
        $('configStatus').textContent = '正在本机内存保存临时配置…';
        try {
          const r = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: $('provider').value,
              model: $('modelName').value,
              key: $('apiKey').value,
              endpoint: $('endpoint').value,
              web_search: $('webSearchOpt').checked
            })
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.reply || d.message || '配置失败');
          $('apiKey').value = '';
          cloudConfigured = !!d.configured;
          $('cloudToggleWrap').classList.toggle('hidden', !cloudConfigured);
          if (cloudConfigured) $('cloudToggle').checked = true;
          $('configStatus').textContent = cloudConfigured
            ? `已在本机启用：${d.provider} / ${d.model}（密钥仅暂存内存，重启清除）`
            : '已保存参数，但尚未填入 API Key。';
        } catch (err) {
          $('configStatus').textContent = err.message;
        }
      };
      if ($('pingModelBtn')) {
        $('pingModelBtn').onclick = async () => {
          $('configStatus').textContent = '⚡ 正在实测模型端到端延迟与思考开关…';
          try {
            const r = await fetch('/api/ping_model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const d = await r.json();
            if (!r.ok) throw new Error(d.reply || '测速失败');
            const sec = (d.latency_ms / 1000).toFixed(2);
            const warn = d.reasoning_tokens > 0
              ? ` ⚠️ 代理仍产生了 ${d.reasoning_tokens} 个隐藏思考 Token`
              : (d.latency_ms > 4500 ? ' ⚠️ 上游节点较慢，可勾选底部「⚡ 4秒极速保底」' : ' ✅ 极速畅通！');
            $('configStatus').textContent = `实测 ${d.model}：${sec} 秒（${d.mode_label}）${warn}`;
          } catch (err) {
            $('configStatus').textContent = '测速失败：' + err.message;
          }
        };
      }
      $('clearKeyBtn').onclick = async () => {
        await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) });
        cloudConfigured = false;
        $('cloudToggle').checked = false;
        $('cloudToggleWrap').classList.add('hidden');
        $('configStatus').textContent = '已清除内存中的 API Key，恢复纯本地模式。';
      };
    }

    // Quick cloud model switcher (works in both GitHub Pages & Local Server modes)
    if ($('cloudModelSelect')) {
      $('cloudModelSelect').onchange = async () => {
        const m = getSelectedCloudModel();
        if (useServerApi) {
          const ep = SCHOOL_MODELS[m] || SCHOOL_MODELS[DEFAULT_CLOUD_MODEL];
          await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'openai', model: m, endpoint: ep, web_search: false })
          }).catch(() => {});
        }
      };
    }

    // Load backend or browser engine
    if (!STATIC_ONLY) {
      try {
        const [metaRes, cfgRes] = await Promise.all([fetch('/api/meta'), fetch('/api/config')]);
        if (!metaRes.ok) throw new Error('local api unavailable');
        const meta = await metaRes.json();
        const cfg = cfgRes.ok ? await cfgRes.json() : {};
        useServerApi = true;
        cloudConfigured = !!cfg.configured;
        if (cloudConfigured && $('cloudToggleWrap')) {
          $('cloudToggleWrap').classList.remove('hidden');
          if ($('cloudToggle')) $('cloudToggle').checked = true;
        }
        if ($('cloudModelSelect') && cfg.model && SCHOOL_MODELS[cfg.model]) {
          $('cloudModelSelect').value = cfg.model;
        }
        populateMeta(meta, cloudConfigured ? 'AI 推荐已就绪' : '片库直搜');
        return;
      } catch {
        // Fallback to static browser engine automatically if opened without Python server
        useServerApi = false;
      }
    }

    cloudConfigured = true;
    $('statusText').textContent = '正在加载片库…';
    try {
      const meta = await browserEngine.load(['catalog_1.pack', 'catalog_2.pack']);
      populateMeta(meta, 'AI 推荐已就绪');
    } catch (err) {
      $('statusText').textContent = '索引加载失败';
      appendBotMessage({
        route: 'error',
        reply: `未能加载片库压缩包（${err.message}）。请通过 HTTP 静态服务器或 GitHub Pages 打开，不要直接双击 file:// 打开。`,
        items: []
      });
    }
  }

  init();
})();
