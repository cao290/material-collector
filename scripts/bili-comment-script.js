/**
 * B站评论采集脚本（在 B站视频详情页上下文里执行）
 * - 内置 MD5 + wbi 签名，直调 /x/v2/reply/wbi/main
 * - 带 cookie，翻页（最多 5 页）
 * - 一级评论 + 其子回复（B站接口随一级评论带前几条 replies）都采集，parent_id 关联
 * - 数量上限：window.__CMT_LIMIT（由采集器注入），达到即停
 * 返回 JSON 字符串：{ comments: [...] } 或 { error: '...' }
 */
(async () => {
  function __md5(input) {
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function au(x, y) { var l = (x & 0xFFFF) + (y & 0xFFFF), m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xFFFF); }
    function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
    function ff(a,b,c,d,x,s,t){return cmn((b&c)|((~b)&d),a,b,x,s,t);}
    function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}
    function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
    function ii(a,b,c,d,x,s,t){return cmn(c^(b|(~d)),a,b,x,s,t);}
    function cv(x){var i,n=((x.length+8)>>6)+1,p=new Array(n*16);for(i=0;i<n*16;i++)p[i]=0;for(i=0;i<x.length;i++)p[i>>2]|=(x.charCodeAt(i)&0xFF)<<((i%4)*8);p[i>>2]|=0x80<<((i%4)*8);p[n*16-2]=x.length*8;return p;}
    function hex(n){var s='',j;for(j=0;j<4;j++)s+=('0'+((n>>(j*8))&0xFF).toString(16)).slice(-2);return s;}
    var x = cv(''+input), a=1732584193, b=-271733879, c=-1732584194, d=271733878, i;
    for(i=0;i<x.length;i+=16){var oa=a,ob=b,oc=c,od=d;
      a=ff(a,b,c,d,x[i],7,-680876936);d=ff(d,a,b,c,x[i+1],12,-389564586);c=ff(c,d,a,b,x[i+2],17,606105819);b=ff(b,c,d,a,x[i+3],22,-1044525330);
      a=ff(a,b,c,d,x[i+4],7,-176418897);d=ff(d,a,b,c,x[i+5],12,1200080426);c=ff(c,d,a,b,x[i+6],17,-1473231341);b=ff(b,c,d,a,x[i+7],22,-45705983);
      a=ff(a,b,c,d,x[i+8],7,1770035416);d=ff(d,a,b,c,x[i+9],12,-1958414417);c=ff(c,d,a,b,x[i+10],17,-42063);b=ff(b,c,d,a,x[i+11],22,-1990404162);
      a=ff(a,b,c,d,x[i+12],7,1804603682);d=ff(d,a,b,c,x[i+13],12,-40341101);c=ff(c,d,a,b,x[i+14],17,-1502002290);b=ff(b,c,d,a,x[i+15],22,1236535329);
      a=gg(a,b,c,d,x[i+1],5,-165796510);d=gg(d,a,b,c,x[i+6],9,-1069501632);c=gg(c,d,a,b,x[i+11],14,643717713);b=gg(b,c,d,a,x[i],20,-373897302);
      a=gg(a,b,c,d,x[i+5],5,-701558691);d=gg(d,a,b,c,x[i+10],9,38016083);c=gg(c,d,a,b,x[i+15],14,-660478335);b=gg(b,c,d,a,x[i+4],20,-405537848);
      a=gg(a,b,c,d,x[i+9],5,568446438);d=gg(d,a,b,c,x[i+14],9,-1019803690);c=gg(c,d,a,b,x[i+3],14,-187363961);b=gg(b,c,d,a,x[i+8],20,1163531501);
      a=gg(a,b,c,d,x[i+13],5,-1444681467);d=gg(d,a,b,c,x[i+2],9,-51403784);c=gg(c,d,a,b,x[i+7],14,1735328473);b=gg(b,c,d,a,x[i+12],20,-1926607734);
      a=hh(a,b,c,d,x[i+5],4,-378558);d=hh(d,a,b,c,x[i+8],11,-2022574463);c=hh(c,d,a,b,x[i+11],16,1839030562);b=hh(b,c,d,a,x[i+14],23,-35309556);
      a=hh(a,b,c,d,x[i+1],4,-1530992060);d=hh(d,a,b,c,x[i+4],11,1272893353);c=hh(c,d,a,b,x[i+7],16,-155497632);b=hh(b,c,d,a,x[i+10],23,-1094730640);
      a=hh(a,b,c,d,x[i+13],4,681279174);d=hh(d,a,b,c,x[i],11,-358537222);c=hh(c,d,a,b,x[i+3],16,-722521979);b=hh(b,c,d,a,x[i+6],23,76029189);
      a=hh(a,b,c,d,x[i+9],4,-640364487);d=hh(d,a,b,c,x[i+12],11,-421815835);c=hh(c,d,a,b,x[i+15],16,530742520);b=hh(b,c,d,a,x[i+2],23,-995338651);
      a=ii(a,b,c,d,x[i],6,-198630844);d=ii(d,a,b,c,x[i+7],10,1126891415);c=ii(c,d,a,b,x[i+14],15,-1416354905);b=ii(b,c,d,a,x[i+5],21,-57434055);
      a=ii(a,b,c,d,x[i+12],6,1700485571);d=ii(d,a,b,c,x[i+3],10,-1894986606);c=ii(c,d,a,b,x[i+10],15,-1051523);b=ii(b,c,d,a,x[i+1],21,-2054922799);
      a=ii(a,b,c,d,x[i+8],6,1873313359);d=ii(d,a,b,c,x[i+15],10,-30611744);c=ii(c,d,a,b,x[i+6],15,-1560198380);b=ii(b,c,d,a,x[i+13],21,1309151649);
      a=ii(a,b,c,d,x[i+4],6,-145523070);d=ii(d,a,b,c,x[i+11],10,-1120210379);c=ii(c,d,a,b,x[i+2],15,718787259);b=ii(b,c,d,a,x[i+9],21,-343485551);
      a=au(a,oa);b=au(b,ob);c=au(c,oc);d=au(d,od);}
    return hex(a)+hex(b)+hex(c)+hex(d);
  }

  var LIMIT = Number(window.__CMT_LIMIT) || 50;
  var MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  var st = window.__INITIAL_STATE__;
  var aid = st && st.videoData && st.videoData.aid;
  if (!aid) return JSON.stringify({ error: 'no aid' });

  var nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then(function(r){ return r.json(); }).catch(function(){ return null; });
  var img = (nav && nav.data && nav.data.wbi_img && nav.data.wbi_img.img_url) || '';
  var sub = (nav && nav.data && nav.data.wbi_img && nav.data.wbi_img.sub_url) || '';
  var keyRaw = (img.split('/').pop() || '').split('.')[0] + (sub.split('/').pop() || '').split('.')[0];
  var wbiKey = MIXIN.map(function(i){ return keyRaw[i]; }).join('').slice(0, 32);

  var all = [];
  var seenIds = {};
  var reachedLimit = false;

  function pushComment(r, parentId) {
    if (!r || !r.rpid) return;
    if (seenIds[String(r.rpid)]) return;
    if (all.length >= LIMIT) { reachedLimit = true; return; }
    seenIds[String(r.rpid)] = 1;
    all.push({
      comment_id: String(r.rpid),
      parent_id: parentId || '',
      author: (r.member && r.member.uname) || '',
      content: (r.content && r.content.message) || '',
      likes: Number(r.like || 0),
      replies: Number(r.rcount || 0),
      location: ((r.reply_control && r.reply_control.location) || '').replace('IP属地：', '')
    });
  }

  var offset = '';
  for (var page = 0; page < 5 && !reachedLimit; page += 1) {
    var params = { oid: String(aid), type: '1', mode: '3', plat: '1', web_location: '1315875', ps: '30' };
    if (offset) params.pagination_str = offset;
    params.wts = String(Math.floor(Date.now() / 1000));
    var query = Object.keys(params).sort()
      .map(function(k){ return encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]).replace(/[!'()*]/g, '')); })
      .join('&');
    var w_rid = __md5(query + wbiKey);
    var url = 'https://api.bilibili.com/x/v2/reply/wbi/main?' + query + '&w_rid=' + w_rid;
    var res = await fetch(url, { credentials: 'include' }).then(function(r){ return r.json(); }).catch(function(){ return null; });
    if (!res || res.code !== 0) return JSON.stringify({ error: 'code ' + (res && res.code), page: page, got: all.length });

    var data = res.data || {};
    var top = data.top_replies || [];
    var replies = data.replies || [];
    // 一级评论（置顶 + 普通），各自带出的子回复（replies 字段）作为二级
    // 注意：top 和 replies 必须分开遍历，合并索引会错位丢评论
    for (var i = 0; i < top.length && !reachedLimit; i += 1) {
      pushComment(top[i], '');
      var topSubs = top[i].replies || [];
      for (var j = 0; j < topSubs.length && !reachedLimit; j += 1) {
        pushComment(topSubs[j], String(top[i].rpid));
      }
    }
    for (var i2 = 0; i2 < replies.length && !reachedLimit; i2 += 1) {
      pushComment(replies[i2], '');
      var subs = replies[i2].replies || [];
      for (var j2 = 0; j2 < subs.length && !reachedLimit; j2 += 1) {
        pushComment(subs[j2], String(replies[i2].rpid));
      }
    }

    var cursor = data.cursor;
    if (!cursor || cursor.is_end) break;
    offset = cursor.pagination_reply ? JSON.stringify({ type: 1, direction: 1, session_id: cursor.session_id, data_id: cursor.pagination_reply.next_offset, code: cursor.pagination_reply.code }) : '';
    if (!offset) break;
  }
  return JSON.stringify({ comments: all, total: all.length, limitReached: reachedLimit });
})()
