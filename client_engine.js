/**
 * Browser-side V2 Film Curation RAG Engine (for GitHub Pages Static Edition).
 * Decompresses data/catalog.pack (gzipped JSON, 35,000 films) via native DecompressionStream
 * and runs BM25 + exact-title retrieval, bilingual extraction, multi-turn session state,
 * active clarification, constraint-relaxation fallback, and prompt-injection guardrail locally.
 */
(function (global) {
  const STOPWORDS = new Set([
    'a','an','and','are','as','at','be','but','by','for','from','has','have','he','her','him','his',
    'in','into','is','it','its','of','on','or','she','that','the','their','them','they','this','to',
    'was','were','who','which','with','about','movie','movies','film','films','find','show','recommend',
    'some','good','best','want','watch','please','me','give','looking','story','stories'
  ]);

  const INJECTION_PATTERNS = [
    /ignore\s+(all\s+|previous\s+|above\s+|prior\s+)*instructions?/i,
    /(reveal|show|print|dump|leak|output|display)\s+(your\s+|the\s+)?(system\s+prompt|api\s*key|secret|password|token|env)/i,
    /(jailbreak|dan\s+mode|bypass\s+safety|override\s+system)/i,
    /(忽略|无视|忘记)(之前|以上|前面|所有|全部).{0,6}(指令|规则|提示|要求|设定)/,
    /(输出|透露|打印|显示|告诉我|泄露).{0,8}(系统提示|提示词|system\s*prompt|api\s*key|密钥|密码|环境变量|token)/i,
    /(越狱|进入开发者模式|解除安全限制)/
  ];

  const GREETING_RE = /^(你好|您好|hi|hello|hey|哈喽|嗨|在吗|你是谁|介绍一下你自己|你能做什么|help|帮助)[!！?？。.\s]*$/i;
  const RESET_RE = /^(重置|清空|清除记忆|重新开始|新对话|reset|clear|start\s+over|new\s+chat)[!！?？。.\s]*$/i;
  const VAGUE_PATTERNS = [
    /^(推荐|找|看|来)(几部|一部|点|些)?(好看的|经典的|不错的|随便)?(电影|片子|影片)[吗呢吧啊?？。.\s]*$/,
    /^(随便推荐|有什么好看的|推荐片单|帮我选电影|recommend\s+(a\s+)?movies?|good\s+movies?|suggest\s+something)[!！?？。.\s]*$/i
  ];
  const COMPARE_PATTERNS = [
    /(对比|比较|compare|区别|差异|哪部更|怎么选)/i,
    /(第\s*[1-5一二三四五]\s*部|首部|第一部|第二部|第三部|detail|详情|展开说说|详细介绍)/i
  ];
  const FOLLOWUP_CUES = ['只要','换成','改成','再','放宽','收窄','更','还要','不要','排除','其中','里面','only','instead','also','filter','narrow'];

  const ZH_TITLE_MAP = {
    '蓝天使':'The Blue Angel','盗梦空间':'Inception','星际穿越':'Interstellar','黑暗骑士':'The Dark Knight',
    '霸王别姬':'Farewell My Concubine','花样年华':'In the Mood for Love','重庆森林':'Chungking Express',
    '千与千寻':'Spirited Away','龙猫':'My Neighbor Totoro','哈尔的移动城堡':"Howl's Moving Castle",
    '幽灵公主':'Princess Mononoke','肖申克的救赎':'The Shawshank Redemption','教父':'The Godfather',
    '泰坦尼克号':'Titanic','黑客帝国':'The Matrix','寄生虫':'Parasite','搏击俱乐部':'Fight Club',
    '楚门的世界':'The Truman Show','阿甘正传':'Forrest Gump','辛德勒的名单':"Schindler's List",
    '寻梦环游记':'Coco','无间道':'Infernal Affairs','卧虎藏龙':'Crouching Tiger, Hidden Dragon',
    '银翼杀手':'Blade Runner','2001太空漫游':'2001: A Space Odyssey','穆赫兰道':'Mulholland Drive',
    '公民凯恩':'Citizen Kane','卡萨布兰卡':'Casablanca','罗马假日':'Roman Holiday',
    '天堂电影院':'Cinema Paradiso','海上钢琴师':'The Legend of 1900','活着':'To Live',
    '让子弹飞':'Let the Bullets Fly','流浪地球':'The Wandering Earth','你的名字':'Your Name',
    '七武士':'Seven Samurai','罗生门':'Rashomon','东京物语':'Tokyo Story','爱乐之城':'La La Land',
    '瞬息全宇宙':'Everything Everywhere All at Once','奥本海默':'Oppenheimer','沙丘':'Dune',
    '降临':'Arrival','机器人总动员':'WALL-E','低俗小说':'Pulp Fiction','沉默的羔羊':'The Silence of the Lambs',
    '闪灵':'The Shining','发条橙':'A Clockwork Orange','指环王':'The Lord of the Rings',
    '星战':'Star Wars','星球大战':'Star Wars','侏罗纪公园':'Jurassic Park','异形':'Alien',
    '终结者':'The Terminator','回到未来':'Back to the Future','美丽人生':'Life Is Beautiful',
    '放牛班的春天':'The Chorus','触不可及':'The Intouchables','天使爱美丽':'Amélie',
    '小偷家族':'Shoplifters','情书':'Love Letter','功夫':'Kung Fu Hustle','英雄':'Hero',
    '杀人回忆':'Memories of Murder','老男孩':'Oldboy','釜山行':'Train to Busan',
    '疯狂动物城':'Zootopia','头脑特工队':'Inside Out','绿皮书':'Green Book',
    '三傻大闹宝莱坞':'3 Idiots','十二怒汉':'12 Angry Men','惊魂记':'Psycho','迷魂记':'Vertigo',
    '后窗':'Rear Window','乱世佳人':'Gone with the Wind','出租车司机':'Taxi Driver',
    '好家伙':'Goodfellas','华尔街之狼':'The Wolf of Wall Street','禁闭岛':'Shutter Island',
    '七宗罪':'Se7en','消失的爱人':'Gone Girl','布达佩斯大饭店':'The Grand Budapest Hotel',
    '爆裂鼓手':'Whiplash','少年派的奇幻漂流':'Life of Pi','魔发奇缘':'Tangled','敢死队':'The Expendables'
  };

  const ZH_DIRECTOR_MAP = {
    '克里斯托弗·诺兰':'Christopher Nolan','克里斯托弗诺兰':'Christopher Nolan','诺兰':'Christopher Nolan',
    '王家卫':'Wong Kar-wai','宫崎骏':'Hayao Miyazaki','黑泽明':'Akira Kurosawa',
    '希区柯克':'Alfred Hitchcock','库布里克':'Stanley Kubrick','斯皮尔伯格':'Steven Spielberg',
    '昆汀':'Quentin Tarantino','塔伦蒂诺':'Quentin Tarantino','奉俊昊':'Bong Joon-ho',
    '朴赞郁':'Park Chan-wook','李安':'Ang Lee','张艺谋':'Zhang Yimou','陈凯歌':'Chen Kaige',
    '侯孝贤':'Hou Hsiao-hsien','杨德昌':'Edward Yang','杜琪峰':'Johnnie To','周星驰':'Stephen Chow',
    '姜文':'Jiang Wen','维伦纽瓦':'Denis Villeneuve','韦斯安德森':'Wes Anderson',
    '大卫芬奇':'David Fincher','斯科塞斯':'Martin Scorsese','科波拉':'Francis Ford Coppola',
    '费里尼':'Federico Fellini','伯格曼':'Ingmar Bergman','塔可夫斯基':'Andrei Tarkovsky',
    '吕克贝松':'Luc Besson','卡梅隆':'James Cameron','雷德利斯科特':'Ridley Scott',
    '是枝裕和':'Hirokazu Kore-eda','新海诚':'Makoto Shinkai','今敏':'Satoshi Kon',
    '岩井俊二':'Shunji Iwai','小津安二郎':'Yasujirō Ozu','大卫林奇':'David Lynch'
  };

  const ZH_ACTOR_MAP = {
    '刘德华':'Andy Lau','梁朝伟':'Tony Leung','周星驰':'Stephen Chow','成龙':'Jackie Chan',
    '周润发':'Chow Yun-fat','张国荣':'Leslie Cheung','张曼玉':'Maggie Cheung','巩俐':'Gong Li',
    '李连杰':'Jet Li','甄子丹':'Donnie Yen','吴京':'Wu Jing','葛优':'Ge You','舒淇':'Shu Qi',
    '汤唯':'Tang Wei','章子怡':'Zhang Ziyi','刘青云':'Sean Lau','古天乐':'Louis Koo',
    '张家辉':'Nick Cheung','任达华':'Simon Yam','黄秋生':'Anthony Wong','曾志伟':'Eric Tsang',
    '梁家辉':'Tony Leung Ka-fai','郭富城':'Aaron Kwok','黎明':'Leon Lai','张学友':'Jacky Cheung',
    '洪金宝':'Sammo Hung','林青霞':'Brigitte Lin','王祖贤':'Joey Wong','梅艳芳':'Anita Mui',
    '杨紫琼':'Michelle Yeoh','黄渤':'Huang Bo','沈腾':'Shen Teng','吴镇宇':'Francis Ng',
    '小李子':'Leonardo DiCaprio','莱昂纳多':'Leonardo DiCaprio','汤姆汉克斯':'Tom Hanks',
    '布拉德皮特':'Brad Pitt','马特达蒙':'Matt Damon','基努里维斯':'Keanu Reeves',
    '汤姆克鲁斯':'Tom Cruise','阿汤哥':'Tom Cruise','斯嘉丽':'Scarlett Johansson',
    '安妮海瑟薇':'Anne Hathaway','宋康昊':'Song Kang-ho','马东锡':'Ma Dong-seok'
  };

  const ZH_COUNTRY_MAP = {
    '美国':'United States','好莱坞':'United States','日本':'Japan','法国':'France','德国':'Germany',
    '英国':'United Kingdom','韩国':'South Korea','中国香港':'Hong Kong','香港':'Hong Kong',
    '中国':'China','大陆':'China','内地':'China','台湾':'Taiwan','意大利':'Italy','西班牙':'Spain',
    '印度':'India','加拿大':'Canada','俄罗斯':'Russia','苏联':'Soviet Union','瑞典':'Sweden',
    '伊朗':'Iran','澳大利亚':'Australia','澳洲':'Australia','墨西哥':'Mexico','丹麦':'Denmark'
  };

  const ZH_GENRE_MAP = {
    '科幻':'science fiction','悬疑':'mystery','惊悚':'thriller','喜剧':'comedy','搞笑':'comedy',
    '爱情':'romance','浪漫':'romance','动作':'action','武侠':'martial arts','功夫':'martial arts',
    '动画':'animated','动漫':'animated','恐怖':'horror','战争':'war','纪录片':'documentary',
    '犯罪':'crime','黑帮':'crime','警匪':'crime','奇幻':'fantasy','魔幻':'fantasy',
    '剧情':'drama','文艺':'drama','历史':'historical','传记':'biographical','音乐':'musical',
    '歌舞':'musical','家庭':'family','冒险':'adventure','黑色电影':'film noir','西部':'western'
  };

  const ZH_CONCEPT_MAP = {
    '太空':['space','astronaut','planet','galaxy'],'宇宙':['space','universe','galaxy','planet'],
    '宇航员':['astronaut','space','mission'],'外星人':['alien','extraterrestrial','invasion'],
    '时间旅行':['time','travel','future','past'],'时空穿越':['time','travel','loop','future'],
    '穿越':['time','travel','past','future'],'人工智能':['artificial','intelligence','robot','android'],
    '机器人':['robot','android','machine'],'赛博朋克':['cyberpunk','dystopian','future','hacker'],
    '侦探':['detective','investigate','investigation','murder','mystery'],
    '谋杀':['murder','killer','detective','investigation'],'破案':['detective','murder','crime'],
    '越狱':['prison','escape','inmate'],'监狱':['prison','inmate','jail'],
    '复仇':['revenge','vengeance','kill'],'黑客':['hacker','computer','cyber'],
    '校园':['school','student','college','teacher'],'青春':['teenager','youth','school'],
    '钢琴':['piano','pianist','music','musician'],'爵士':['jazz','musician','band'],
    '吸血鬼':['vampire','blood','immortal'],'丧尸':['zombie','outbreak','survivor'],
    '间谍':['spy','agent','espionage'],'特工':['agent','spy','mission'],
    '律师':['lawyer','court','trial'],'法庭':['court','trial','jury'],
    '二战':['world','war','nazi','soldier'],'末日':['apocalypse','survivor','disaster'],
    '厨师':['chef','restaurant','cooking'],'梦境':['dream','subconscious','mind'],
    '记忆':['memory','amnesia','forget'],'家庭':['family','father','mother','son'],
    '魔法':['magic','wizard','witch'],'劫案':['heist','robbery','thief']
  };

  function normText(s) {
    return (s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function tokenizeEn(text) {
    const raw = normText(text).match(/[a-z0-9_]+(?:'[a-z0-9_]+)?/g) || [];
    return raw.filter(t => t.length >= 2 && !STOPWORDS.has(t));
  }

  const GENRE_ALIASES = {
    'animated': ['animated', 'animation', 'anime'],
    'science fiction': ['science fiction', 'sci-fi'],
    'mystery': ['mystery', 'detective', 'whodunit', 'thriller']
  };

  class BrowserMovieEngine {
    constructor() {
      this.movies = [];
      this.ready = false;
      this.titleExactMap = new Map();
      this.postings = new Map();
      this.titlePostings = new Map();
      this.idf = new Map();
      this.docLen = [];
      this.avgDl = 1;
      this.genres = [];
      this.countries = [];
      this.session = { slots: {}, last_topic: '', last_results: [], history: [] };
    }

    async load(packUrl = 'data/catalog.pack') {
      const resp = await fetch(packUrl);
      if (!resp.ok) throw new Error('无法下载片库文件 ' + packUrl);
      let text;
      if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        const decompressed = resp.body.pipeThrough(ds);
        text = await new Response(decompressed).text();
      } else {
        throw new Error('当前浏览器不支持原生 Gzip 解压，请使用最新版 Chrome/Edge/Firefox/Safari。');
      }
      this.movies = JSON.parse(text);
      this._buildIndex();
      this.ready = true;
      return {
        records: this.movies.length,
        genres: this.genres,
        countries: this.countries,
        year_range: '1930–2024',
        with_directors: this.movies.filter(m => m.directors && m.directors.length).length,
        with_awards: this.movies.filter(m => m.awards).length
      };
    }

    _buildIndex() {
      const n = this.movies.length;
      const gCount = new Map(), cCount = new Map();
      this.docLen = new Int32Array(n);
      let totalLen = 0;

      for (let i = 0; i < n; i++) {
        const m = this.movies[i];
        m._tn = normText(m.title);
        m._dir = (m.directors || []).join(' ').toLowerCase();
        m._cast = (m.cast || []).join(' ').toLowerCase();
        m._gl = (m.genres || []).map(g => g.toLowerCase());
        m._cl = (m.country || '').toLowerCase();
        m._y = /^\d{4}$/.test(m.year || '') ? parseInt(m.year, 10) : null;

        if (!this.titleExactMap.has(m._tn)) this.titleExactMap.set(m._tn, []);
        this.titleExactMap.get(m._tn).push(i);
        if (m.title_zh) {
          const tzh = normText(m.title_zh);
          if (!this.titleExactMap.has(tzh)) this.titleExactMap.set(tzh, []);
          this.titleExactMap.get(tzh).push(i);
        }

        for (const g of m.genres || []) gCount.set(g, (gCount.get(g) || 0) + 1);
        if (m.country) cCount.set(m.country, (cCount.get(m.country) || 0) + 1);

        const tf = new Map();
        const tToks = tokenizeEn(m.title);
        const tSeen = new Set();
        for (const t of tToks) {
          tf.set(t, (tf.get(t) || 0) + 5);
          if (!tSeen.has(t)) {
            tSeen.add(t);
            if (!this.titlePostings.has(t)) this.titlePostings.set(t, []);
            this.titlePostings.get(t).push(i);
          }
        }
        const metaStr = [m._dir, m._cast, (m.genres || []).join(' '), m.country || '', m.awards || ''].join(' ');
        for (const t of tokenizeEn(metaStr)) tf.set(t, (tf.get(t) || 0) + 2);
        for (const t of tokenizeEn(m.plot || '')) tf.set(t, (tf.get(t) || 0) + 1);

        let dl = 0;
        for (const [term, freq] of tf.entries()) {
          dl += freq;
          if (!this.postings.has(term)) this.postings.set(term, []);
          this.postings.get(term).push(i, freq);
        }
        this.docLen[i] = dl || 1;
        totalLen += this.docLen[i];
      }

      this.avgDl = totalLen / Math.max(1, n);
      for (const [term, arr] of this.postings.entries()) {
        const df = arr.length / 2;
        this.idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
      }
      this.genres = [...gCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(x => x[0]);
      this.countries = [...cCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(x => x[0]);
    }

    resetSession() {
      this.session = { slots: {}, last_topic: '', last_results: [], history: [] };
    }

    extractStructured(query, uiFilters) {
      const qNorm = (query || '').normalize('NFKC').trim();
      const qLow = qNorm.toLowerCase();
      const f = uiFilters || {};
      const ext = {
        region: (f.region === '国产' || f.region === '国外') ? f.region : null,
        genre: f.genre || null,
        country: f.country || null,
        director: ZH_DIRECTOR_MAP[(f.director || '').trim()] || (f.director || '').trim(),
        actor: ZH_ACTOR_MAP[(f.actor || '').trim()] || (f.actor || '').trim(),
        year_min: f.year_min ? parseInt(f.year_min, 10) : (f.year ? parseInt(f.year, 10) : null),
        year_max: f.year_max ? parseInt(f.year_max, 10) : (f.year ? parseInt(f.year, 10) : null),
        min_rating: f.min_rating !== undefined && f.min_rating !== '' && f.min_rating !== null ? parseFloat(f.min_rating) : null,
        awards_only: !!f.awards_only,
        mapped_title: null,
        expanded_terms: [],
        extracted_notes: []
      };

      for (const zh of Object.keys(ZH_TITLE_MAP).sort((a, b) => b.length - a.length)) {
        if (qNorm.includes(zh)) {
          ext.mapped_title = ZH_TITLE_MAP[zh];
          ext.extracted_notes.push(`中文片名映射: ${zh} → ${ext.mapped_title}`);
          break;
        }
      }
      if (!ext.director) {
        for (const zh of Object.keys(ZH_DIRECTOR_MAP).sort((a, b) => b.length - a.length)) {
          if (qNorm.includes(zh)) {
            ext.director = ZH_DIRECTOR_MAP[zh];
            ext.extracted_notes.push(`导演: ${ext.director}`);
            break;
          }
        }
      }
      if (!ext.actor) {
        for (const zh of Object.keys(ZH_ACTOR_MAP).sort((a, b) => b.length - a.length)) {
          if (qNorm.includes(zh)) {
            ext.actor = ZH_ACTOR_MAP[zh];
            ext.extracted_notes.push(`演员: ${zh} (${ext.actor})`);
            break;
          }
        }
      }
      if (!ext.region) {
        if (/国产|华语|国内电影|国产片/.test(qNorm)) {
          ext.region = '国产'; ext.extracted_notes.push('国别: 国产/华语');
        } else if (/国外|外国|海外|外语片|欧美/.test(qNorm)) {
          ext.region = '国外'; ext.extracted_notes.push('国别: 国外');
        }
      }
      if (!ext.country) {
        for (const zh of Object.keys(ZH_COUNTRY_MAP).sort((a, b) => b.length - a.length)) {
          if (qNorm.includes(zh)) {
            ext.country = ZH_COUNTRY_MAP[zh];
            ext.extracted_notes.push(`国家/地区: ${ext.country}`);
            break;
          }
        }
      }
      if (!ext.genre) {
        for (const zh of Object.keys(ZH_GENRE_MAP).sort((a, b) => b.length - a.length)) {
          if (qNorm.includes(zh)) {
            ext.genre = ZH_GENRE_MAP[zh];
            ext.extracted_notes.push(`类型: ${ext.genre}`);
            break;
          }
        }
      }
      if (ext.year_min == null && ext.year_max == null) {
        let m;
        if ((m = qNorm.match(/(19\d{2}|20[0-2]\d)\s*(?:-|–|~|到|至)\s*(19\d{2}|20[0-2]\d)/))) {
          const y1 = +m[1], y2 = +m[2];
          ext.year_min = Math.min(y1, y2); ext.year_max = Math.max(y1, y2);
          ext.extracted_notes.push(`年份: ${ext.year_min}–${ext.year_max}`);
        } else if ((m = qNorm.match(/(19\d0|20[0-2]0)\s*(?:年代|s\b)/i))) {
          ext.year_min = +m[1]; ext.year_max = +m[1] + 9;
          ext.extracted_notes.push(`年代: ${ext.year_min}–${ext.year_max}`);
        } else if ((m = qNorm.match(/([3-9]0)\s*年代/))) {
          ext.year_min = 1900 + +m[1]; ext.year_max = ext.year_min + 9;
          ext.extracted_notes.push(`年代: ${ext.year_min}–${ext.year_max}`);
        } else if ((m = qNorm.match(/(19\d{2}|20[0-2]\d)\s*(?:年)?(?:以后|之后|后|以来|\+)/) || qLow.match(/(?:after|since)\s+(19\d{2}|20[0-2]\d)/))) {
          ext.year_min = +m[1]; ext.extracted_notes.push(`年份 ≥ ${ext.year_min}`);
        } else if ((m = qNorm.match(/(19\d{2}|20[0-2]\d)\s*(?:年)?(?:以前|之前|前)/) || qLow.match(/(?:before|until)\s+(19\d{2}|20[0-2]\d)/))) {
          ext.year_max = +m[1]; ext.extracted_notes.push(`年份 ≤ ${ext.year_max}`);
        } else if ((m = qNorm.match(/(19\d{2}|20[0-2]\d)\s*年/))) {
          ext.year_min = +m[1]; ext.year_max = +m[1]; ext.extracted_notes.push(`年份: ${ext.year_min}`);
        } else if (qNorm.includes('近十年')) {
          ext.year_min = 2015; ext.extracted_notes.push('年份 ≥ 2015');
        }
      }
      if (ext.min_rating == null) {
        const mr = qNorm.match(/(?:评分|口碑|分数|rating)?\s*(?:>=|≥|高于|大于|超过)?\s*(\d(?:\.\d)?)\s*分(?:以上|及以上)?/i)
          || qLow.match(/(?:rating|rated|score)\s*(?:>=|>|above|over)\s*(\d(?:\.\d)?)/);
        if (mr && parseFloat(mr[1]) > 0 && parseFloat(mr[1]) <= 11) {
          ext.min_rating = parseFloat(mr[1]);
          ext.extracted_notes.push(`最低评分 ≥ ${ext.min_rating}`);
        } else if (/高分|高评分|高口碑|神作|佳作|top rated/i.test(qNorm)) {
          ext.min_rating = ext.actor ? 7.0 : 7.5;
          ext.extracted_notes.push(`高分预设 ≥ ${ext.min_rating}`);
        }
      }
      if (!ext.awards_only && /获奖|奥斯卡|戛纳|金狮|柏林|oscar|award/i.test(qLow)) {
        ext.awards_only = true;
        ext.extracted_notes.push('仅看有获奖记录影片');
      }
      const expSet = new Set();
      for (const [k, arr] of Object.entries(ZH_CONCEPT_MAP)) {
        if (qNorm.includes(k)) arr.forEach(w => expSet.add(w));
      }
      if (expSet.size) {
        ext.expanded_terms = [...expSet];
        ext.extracted_notes.push(`双语主题词扩展: ${ext.expanded_terms.slice(0, 6).join(', ')}`);
      }
      return ext;
    }

    _passes(m, flt) {
      if (flt.region === '国产' || flt.region === '国外') {
        const reg = m.region || ((m._cl.includes('china') || m._cl === 'hong kong' || m._cl === 'taiwan') ? '国产' : '国外');
        if (reg !== flt.region) return false;
      }
      if (flt.genre) {
        const gLow = flt.genre.toLowerCase();
        const aliases = GENRE_ALIASES[gLow] || [gLow];
        if (!m._gl.some(g => aliases.some(a => g.includes(a)))) return false;
      }
      if (flt.country && m._cl !== flt.country.toLowerCase() && !m._cl.includes(flt.country.toLowerCase())) return false;
      if (flt.director && !m._dir.includes(flt.director.toLowerCase())) return false;
      if (flt.actor && !m._cast.includes(flt.actor.toLowerCase())) return false;
      if (flt.year_min != null && (m._y == null || m._y < flt.year_min)) return false;
      if (flt.year_max != null && (m._y == null || m._y > flt.year_max)) return false;
      if (flt.min_rating != null && flt.min_rating > 0 && (m.rating == null || m.rating < flt.min_rating)) return false;
      if (flt.awards_only && !m.awards) return false;
      return true;
    }

    retrieve(query, flt, offset = 0, limit = 8) {
      const t0 = performance.now();
      const phrase = normText(flt.mapped_title || query);
      let enTerms = tokenizeEn(flt.mapped_title || query);
      const hasFilters = !!(flt.region || flt.genre || flt.country || flt.director || flt.actor || flt.year_min != null || flt.year_max != null || (flt.min_rating != null && flt.min_rating > 0) || flt.awards_only);
      if (hasFilters && !flt.mapped_title && (flt.year_min != null || flt.year_max != null || flt.min_rating != null)) {
        enTerms = enTerms.filter(t => !/^\d+$/.test(t));
      }
      const enSet = new Set(enTerms);
      const allTerms = [...new Set([...enTerms, ...(flt.expanded_terms || [])])];

      const scores = new Map();
      if (phrase && this.titleExactMap.has(phrase)) {
        for (const idx of this.titleExactMap.get(phrase)) {
          const m = this.movies[idx];
          if (this._passes(m, flt)) scores.set(idx, (scores.get(idx) || 0) + 500 + 12 * Math.log1p(m.votes) + 2 * (m.rating || 0));
        }
      }

      const k1 = 1.5, b = 0.75;
      for (const term of allTerms) {
        const idf = this.idf.get(term);
        if (!idf) continue;
        const w = enSet.has(term) ? 1.0 : 0.75;
        const plist = this.postings.get(term);
        for (let p = 0; p < plist.length; p += 2) {
          const idx = plist[p], tf = plist[p + 1];
          const dl = this.docLen[idx];
          const bm25 = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / this.avgDl));
          scores.set(idx, (scores.get(idx) || 0) + w * bm25);
        }
        const tlist = this.titlePostings.get(term);
        if (tlist) {
          for (const idx of tlist) scores.set(idx, (scores.get(idx) || 0) + w * 3.2 * idf);
        }
      }

      if (phrase.length >= 4 && /[a-z]/.test(phrase)) {
        const iter = scores.size ? scores.keys() : this.movies.keys();
        for (const idx of iter) {
          const tn = this.movies[idx]._tn;
          if (tn === phrase) scores.set(idx, Math.max(scores.get(idx) || 0, 500));
          else if (tn.includes(phrase)) scores.set(idx, (scores.get(idx) || 0) + 40);
        }
      }

      if (!scores.size && hasFilters) {
        const dirTokensOk = flt.director && enTerms.every(t => flt.director.toLowerCase().includes(t));
        if (!enTerms.length || dirTokensOk) {
          for (let i = 0; i < this.movies.length; i++) {
            const m = this.movies[i];
            if (this._passes(m, flt)) scores.set(i, (m.rating || 0) * 10 + Math.log1p(m.votes) * 2);
          }
        }
      }

      const ranked = [];
      for (const [idx, s] of scores.entries()) {
        const m = this.movies[idx];
        if (!this._passes(m, flt)) continue;
        const tie = 0.06 * (m.rating || 0) + 0.015 * Math.log1p(m.votes);
        ranked.push([s + tie, s, idx]);
      }
      ranked.sort((a, b) => b[0] - a[0] || ((this.movies[b[2]].rating || 0) - (this.movies[a[2]].rating || 0)) || this.movies[a[2]]._tn.localeCompare(this.movies[b[2]]._tn));

      const total = ranked.length;
      const start = Math.max(0, Math.min(offset || 0, Math.max(0, total - 1)));
      const items = ranked.slice(start, start + limit).map(([, rawS, idx]) => ({ ...this.movies[idx], relevance: Math.round(rawS * 100) / 100 }));
      return {
        items,
        total,
        hit_id: items[0]?.id || null,
        latency_ms: Math.round((performance.now() - t0) * 100) / 100
      };
    }

    analyzeRelaxations(query, flt) {
      const labels = [
        ['min_rating', '放宽最低评分限制'],
        ['awards_only', '取消「仅看获奖影片」限制'],
        ['year_min', '放宽年份范围限制'],
        ['year_max', '放宽年份范围限制'],
        ['country', '不限国家/地区'],
        ['genre', '不限电影类型'],
        ['director', '不限导演'],
        ['actor', '不限演员']
      ];
      const out = [];
      for (const [key, label] of labels) {
        if (!flt[key] || out.some(x => x.label === label)) continue;
        const relaxed = { ...flt };
        if (key === 'year_min' || key === 'year_max') { relaxed.year_min = null; relaxed.year_max = null; }
        else if (key === 'awards_only') relaxed.awards_only = false;
        else relaxed[key] = (key === 'director' || key === 'actor') ? '' : null;
        const r = this.retrieve(query, relaxed, 0, 1);
        if (r.total > 0) out.push({ label, drop_key: key, estimated_total: r.total });
        if (out.length >= 3) break;
      }
      return out;
    }

    chat(query, uiFilters = null, offset = 0) {
      const t0 = performance.now();
      const trace = [];
      const q = (query || '').trim();
      if (!q || q.length > 500) {
        return { route: 'clarify', reply: '请输入 1–500 个字符的电影线索、片名、导演或策展需求。', items: [], total: 0, hit_id: null, slots: this.session.slots, trace: [{ step: '输入校验', status: 'clarify', detail: '长度不合法' }] };
      }
      if (INJECTION_PATTERNS.some(p => p.test(q))) {
        trace.push({ step: '安全护栏', status: 'blocked', detail: '拦截疑似 Prompt Injection / 敏感探测' });
        return { route: 'security_refusal', reply: '检测到疑似提示词注入或敏感信息探测请求。本系统仅提供公开电影资料检索与策展分析，不会透露系统提示词、密钥或执行越权指令。', items: [], total: 0, hit_id: null, slots: this.session.slots, suggestions: ['找一部关于人工智能的高分科幻片', '蓝天使', '1990年代日本动画'], trace };
      }
      trace.push({ step: '安全护栏', status: 'pass', detail: '未检测到注入或越权特征' });

      if (RESET_RE.test(q)) {
        this.resetSession();
        trace.push({ step: '意图路由', status: 'reset', detail: '已清空对话历史与筛选记忆槽位' });
        return { route: 'reset', reply: '已为您重置当前调研会话与所有记忆槽位。请告诉我您想调研的电影主题、导演、年代或剧情线索！', items: [], total: 0, hit_id: null, slots: {}, suggestions: ['诺兰导演的高分科幻片', '1990年代美国悬疑电影', '宫崎骏的动画电影', 'a family travels through space'], trace };
      }

      if (GREETING_RE.test(q)) {
        trace.push({ step: '意图路由', status: 'clarify', detail: '欢迎与能力说明' });
        return { route: 'clarify', reply: `您好！我是 **片刻 CineCurator**（浏览器本地全量索引版），内置 **${this.movies.length.toLocaleString()}** 部 1930–2024 年公开电影档案。支持中英文多条件查询、多轮追问对比与片单导出！`, items: [], total: 0, hit_id: null, slots: this.session.slots, suggestions: ['1990年代评分8分以上的美国悬疑电影', '诺兰导演的科幻片', '关于人工智能或太空探索的电影', '盗梦空间'], trace };
      }

      if (this.session.last_results.length && COMPARE_PATTERNS.some(p => p.test(q))) {
        const last = this.session.last_results;
        const mIdx = q.match(/第\s*([1-5一二三四五])\s*部|(首部)/);
        if (mIdx && !/(对比|比较|compare)/i.test(q)) {
          const map = { '1':0,'一':0,'首':0,'2':1,'二':1,'3':2,'三':2,'4':3,'四':3,'5':4,'五':4 };
          const pos = map[mIdx[1] || '首'] || 0;
          if (pos < last.length) {
            const m = last[pos];
            const reply = `### 影片详档：《${m.title}》[${m.id}]\n- **年份 / 地区 / 片长**：${m.year || '未知'} · ${m.country || '未知'} · ${m.minutes || '未知'} 分钟\n- **导演**：${(m.directors || []).join(', ') || '未知'}\n- **主要演员**：${(m.cast || []).join(', ') || '未知'}\n- **类型**：${(m.genres || []).join(', ') || '未知'}\n- **TMDb 快照评分**：${m.rating != null ? `${m.rating.toFixed(1)}/10（${m.votes.toLocaleString()} 票）` : '暂无'}\n- **获奖记录**：${m.awards || '索引快照中暂无获奖条目'}\n- **剧情梗概**：${m.plot}`;
            trace.push({ step: '多轮上下文', status: 'context_detail', detail: `基于上轮结果展开第 ${pos + 1} 部详情` });
            return { route: 'context_detail', reply, items: [m], total: 1, hit_id: m.id, slots: this.session.slots, trace, latency_ms: Math.round((performance.now() - t0) * 100) / 100 };
          }
        }
        const nCmp = /(两部|二部|2\s*部|top\s*2)/i.test(q) ? 2 : 3;
        const top = last.slice(0, nCmp);
        if (top.length >= 2) {
          const tdisp = m => (m.title_zh && m.title_zh !== m.title) ? `${m.title_zh} (${m.title})` : m.title;
          const lines = [
            '### 当前候选片单横向对比（基于上轮检索证据）', '',
            '| 维度 | ' + top.map(m => `《${tdisp(m)}》[${m.id}]`).join(' | ') + ' |',
            '| --- | ' + top.map(() => '---').join(' | ') + ' |',
            '| 国别 | ' + top.map(m => m.region || '国外').join(' | ') + ' |',
            '| 年份 | ' + top.map(m => m.year || '未知').join(' | ') + ' |',
            '| 国家/地区 | ' + top.map(m => m.country || '未知').join(' | ') + ' |',
            '| 导演 | ' + top.map(m => (m.directors && m.directors[0]) || '未知').join(' | ') + ' |',
            '| 类型 | ' + top.map(m => (m.genres || ['未知']).slice(0, 2).join(', ')).join(' | ') + ' |',
            '| TMDb 评分 | ' + top.map(m => m.rating != null ? `${m.rating.toFixed(1)} (${m.votes.toLocaleString()}票)` : '缺失').join(' | ') + ' |',
            '| 片长 | ' + top.map(m => m.minutes ? `${m.minutes}分钟` : '缺失').join(' | ') + ' |',
            '| 获奖记录 | ' + top.map(m => m.awards ? '有' : '无快照').join(' | ') + ' |'
          ];
          trace.push({ step: '多轮上下文', status: 'context_compare', detail: `对比上轮前 ${top.length} 部影片` });
          return { route: 'context_compare', reply: lines.join('\n'), items: top, total: top.length, hit_id: top[0].id, slots: this.session.slots, trace, latency_ms: Math.round((performance.now() - t0) * 100) / 100 };
        }
      }

      const ext = this.extractStructured(q, uiFilters);
      const hasNew = !!(ext.region || ext.genre || ext.country || ext.director || ext.actor || ext.year_min != null || ext.year_max != null || ext.min_rating != null || ext.awards_only || ext.mapped_title || ext.expanded_terms.length);
      const enTerms = tokenizeEn(q);

      if (VAGUE_PATTERNS.some(p => p.test(q)) && !hasNew && !Object.keys(this.session.slots).length) {
        trace.push({ step: '意图路由', status: 'clarify', detail: '需求宽泛，触发主动澄清' });
        return {
          route: 'clarify',
          reply: '为了帮您精准缩小片单范围，能否补充以下任意 1–2 个维度？\n1. **国别 / 地区**（如：国产/华语、国外、美国、日本、法国）\n2. **题材或剧情线索**（如：科幻/悬疑/喜剧/时间旅行/侦探破案）\n3. **演员 / 导演 / 口碑**（如：刘德华、梁朝伟、诺兰、评分 7.5 以上）',
          items: [], total: 0, hit_id: null, slots: this.session.slots,
          suggestions: ['刘德华有哪些高评分的电影推荐？', '国产高分剧情或科幻电影', '90年代评分8分以上的美国悬疑片', '宫崎骏导演的日本动画'],
          trace
        };
      }

      const hasPrev = Object.keys(this.session.slots).length > 0 || !!this.session.last_topic;
      const isFollowup = hasPrev && !uiFilters && (FOLLOWUP_CUES.some(c => q.toLowerCase().includes(c)) || (hasNew && !enTerms.length && !ext.mapped_title && !ext.expanded_terms.length));
      const merged = { ...ext };
      let searchQ = q;
      if (isFollowup) {
        const prev = this.session.slots;
        for (const k of ['region','genre','country','director','actor','year_min','year_max','min_rating','awards_only','mapped_title']) {
          if (!merged[k] && prev[k]) merged[k] = prev[k];
        }
        if (!merged.expanded_terms.length && prev.expanded_terms) merged.expanded_terms = [...prev.expanded_terms];
        if (!enTerms.length && !ext.mapped_title && this.session.last_topic) searchQ = this.session.last_topic;
        trace.push({ step: '多轮状态继承', status: 'merged', detail: '继承上轮记忆槽位并叠加新条件' });
      } else {
        trace.push({ step: '结构化抽取', status: ext.extracted_notes.length ? 'extracted' : 'lexical', detail: ext.extracted_notes.join(' · ') || '自由文本片名/剧情检索' });
      }

      const anySignal = !!(tokenizeEn(merged.mapped_title || searchQ).length || merged.expanded_terms.length || merged.region || merged.genre || merged.country || merged.director || merged.actor || merged.year_min != null || merged.year_max != null || merged.min_rating != null || merged.awards_only || this.titleExactMap.has(normText(searchQ)));
      if (!anySignal) {
        trace.push({ step: '检索前校验', status: 'clarify', detail: '未命中英文词项或内置双语词典' });
        return {
          route: 'clarify',
          reply: '您的描述暂未命中片库内置中文片名、演员/导演词典或结构化筛选条件。\n建议：**指定国别/演员/导演/题材**（例如「刘德华有哪些高评分的电影推荐」「国产科幻片」「诺兰」「90年代悬疑」）。',
          items: [], total: 0, hit_id: null, slots: this.session.slots,
          suggestions: ['刘德华有哪些高评分的电影推荐？', '梁朝伟的高分电影', '国产高分电影', '关于太空探索的高分科幻片'],
          trace
        };
      }

      const res = this.retrieve(searchQ, merged, offset, 8);
      trace.push({ step: 'BM25片库检索', status: res.total ? 'hit' : 'miss', detail: `扫描 ${this.movies.length.toLocaleString()} 条索引 → 命中 ${res.total.toLocaleString()} 条（${res.latency_ms} ms）` });

      const savedSlots = {};
      for (const k of ['region','genre','country','director','actor','year_min','year_max','min_rating','awards_only','mapped_title','expanded_terms']) {
        const v = merged[k];
        if (v !== null && v !== undefined && v !== '' && v !== false && !(Array.isArray(v) && !v.length)) savedSlots[k] = v;
      }
      this.session.slots = savedSlots;
      if (tokenizeEn(searchQ).length || merged.mapped_title) this.session.last_topic = merged.mapped_title || searchQ;

      if (!res.total) {
        const relax = this.analyzeRelaxations(searchQ, merged);
        trace.push({ step: '无证据备援', status: 'fallback', detail: `提供 ${relax.length} 条放宽恢复建议，拒绝编造` });
        const relaxText = relax.length ? '\n\n**智能备援建议（放宽单一条件即可恢复结果）**：\n' + relax.map(r => `- ${r.label}（预计可恢复约 **${r.estimated_total.toLocaleString()}** 部影片）`).join('\n') : '';
        return { route: 'no_evidence', reply: `当前条件下未在 ${this.movies.length.toLocaleString()} 部电影索引中找到匹配记录。为避免幻觉，**本系统不会编造电影事实**。${relaxText}`, items: [], total: 0, hit_id: null, slots: savedSlots, relaxations: relax, trace, latency_ms: Math.round((performance.now() - t0) * 100) / 100 };
      }

      this.session.last_results = res.items;
      const lines = [`在 ${this.movies.length.toLocaleString()} 部电影资料库中共检索到 **${res.total.toLocaleString()}** 条匹配证据，按 BM25 相关性与片名精确度为您整理前列参考片单：`];
      res.items.slice(0, 4).forEach((m, i) => {
        const tDisp = (m.title_zh && m.title_zh !== m.title) ? `${m.title_zh} (${m.title})` : m.title;
        const dirs = (m.directors && m.directors.length) ? m.directors.join(' / ') : '导演信息缺失';
        const rat = m.rating != null ? `TMDb ${m.rating.toFixed(1)}/10（${m.votes.toLocaleString()}票）` : '评分缺失';
        const awd = m.awards ? ' · 🏆 含获奖记录' : '';
        lines.push(`${i + 1}. **《${tDisp}》**（${m.year || '年份未知'} · ${m.region || ''} · [${m.id}]）— 导演：${dirs} · ${rat}${awd}`);
      });
      lines.push('💡 可继续追问：「只要 2000 年以后的」「评分 7.5 分以上」「对比前两部」或「详细介绍第 1 部」。');
      trace.push({ step: '浏览器本地综合', status: 'ok', detail: '纯前端确定性汇总（零幻觉、无需后端）' });
      return { route: 'rag_local', reply: lines.join('\n'), items: res.items, total: res.total, hit_id: res.hit_id, slots: savedSlots, trace, latency_ms: Math.round((performance.now() - t0) * 100) / 100 };
    }
  }

  global.BrowserMovieEngine = BrowserMovieEngine;
})(window);
