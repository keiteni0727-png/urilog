/* ============================================================
   ここから旧 shared/u-sync.js（同期の見張り役）。ウリログ専用に取り込み
   ============================================================ */
/* ===================== 保存と同期の見張り役：4アプリ（エンタメ管理・おかね手帳・FitLife・ウリログ）で同じファイルを使う =====================
  ふつうの <script> で読み込む（window.USync）。Firebase を使うコードより前に置く。

  使い方
    エンタメ管理・おかね手帳 … u-core.js が中で使う（U.sync は USync と同じもの）
    FitLife・ウリログ        … const W = USync.wrap(Firestoreの関数一式, db, { id:"アプリ名", badge:true })
                               W.onSnapshot / W.setDoc / W.updateDoc / W.addDoc / W.deleteDoc / W.writeBatch / W.runTransaction を、
                               Firebase の同じ名前の関数と同じ書き方で使う

  やっていること
    ・読み込み（onSnapshot）が止まったら、少し待って自動でつなぎ直す（開き直さなくても戻る）
    ・書き込みが失敗したら、自動で保存し直す（同じ文書をあとから丸ごと書いたときは、古い失敗は捨てる）
      まとめ書き・トランザクションは、やり直すと二重になるおそれがあるので自動ではやり直さない（失敗を知らせるだけ）
    ・iPhoneで裏から戻ったとき・電波が戻ったとき・保存が20秒以上終わらないときは、通信をつなぎ直す
    ・端末内の保存場所が壊れたとき（iPhoneで長く裏にいたあとなど）は、未保存がなければ自動で開き直す
    ・badge:true のアプリは、保存できていない変更があるときだけ画面の下に小さく知らせる

  状態を見る
    USync.on(関数)      … 状態が変わるたびに呼ぶ（すぐ1回呼ぶ）。返り値で止める
    USync.view(同期済み) … 表示用の [種類 ok/busy/wait/err, 文字, 説明]
    USync.retry()       … 保存し直し・つなぎ直しを今すぐ行う */
window.USync = (() => {
  const SY = { pend: new Map(), fails: new Map(), lerr: new Map(), fatal: null, online: navigator.onLine !== false, at: 0, id: "app" };
  const subs = new Set();
  let emitQ = false;
  const emit = () => {
    if (emitQ) return;
    emitQ = true;
    queueMicrotask(() => {
      emitQ = false;
      subs.forEach(f => {
        try {
          f(SY);
        } catch (e) {
          console.warn(e);
        }
      });
    });
  };
  SY.on = f => {
    subs.add(f);
    f(SY);
    return () => subs.delete(f);
  };
  const hm = t => `${new Date(t).getHours()}:${String(new Date(t).getMinutes()).padStart(2, "0")}`;
  const failDocs = () => new Set([...SY.fails.values()].map(w => w.path)).size;
  SY.view = (synced = true) => {
    if (SY.fatal) return ["err", "接続エラー", "画面を開き直してください"];
    if (SY.fails.size) {
      const perm = [...SY.fails.values()].find(w => w.perm);
      return ["err", `未保存 ${failDocs()}件`, perm ? `保存できませんでした（${perm.code || "error"}）` : "自動で保存し直しています"];
    }
    if (SY.lerr.size) return ["err", "再接続中…", "読み込みが止まったので、自動でつなぎ直しています"];
    if (SY.pend.size) return SY.online ? ["busy", "保存中…", ""] : ["busy", "オフライン", "電波が戻ったら自動で保存します"];
    if (!SY.online) return ["wait", "オフライン", ""];
    if (!synced) return ["wait", "同期中…", "最新のデータを読み込んでいます"];
    return ["ok", "保存済み", SY.at ? `最後の保存 ${hm(SY.at)}` : ""];
  };

  /* 失敗の見分け：一時的なもの（電波など）は自動で保存し直す。端末内の保存場所が壊れたものは開き直す */
  const TEMP = new Set(["unavailable", "deadline-exceeded", "aborted", "internal", "unknown", "cancelled", "resource-exhausted"]);
  const BROKEN = /IndexedDB|INTERNAL ASSERTION|required state|refresh the (browser|page)|persistence layer/i;
  const isBroken = e => !!e && BROKEN.test(String(e.message || e));
  SY.isTemp = e => !!e && TEMP.has(e.code);
  const RETRY_S = [3, 10, 30, 60, 120];

  /* 画面の上に出す帯（開き直すボタンつき）・下に出す小さな知らせ。どのアプリでも同じ見た目（色は端末の明暗に合わせる） */
  const DARK = matchMedia("(prefers-color-scheme: dark)");
  const boxCss = top =>
    `position:fixed;left:50%;transform:translateX(-50%);${top ? "top:calc(10px + env(safe-area-inset-top,0px))" : "bottom:calc(84px + env(safe-area-inset-bottom,0px))"};z-index:2147483000;display:flex;align-items:center;gap:12px;width:max-content;max-width:calc(100% - 24px);border-radius:12px;padding:8px 8px 8px 16px;font:13px/1.5 system-ui,-apple-system,"Hiragino Sans",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);background:${DARK.matches ? "#f2f2f4" : "#26262b"};color:${DARK.matches ? "#1c1c1e" : "#fff"}`;
  const btnCss = "border:0;border-radius:8px;padding:6px 12px;font:700 12.5px/1.5 inherit;white-space:nowrap;cursor:pointer;background:#e8743b;color:#fff";
  function bar(id, top, text, label, onClick) {
    let el = document.getElementById(id);
    if (!text) return void (el && el.remove());
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.setAttribute("role", top ? "alert" : "status");
      el.innerHTML = `<span></span><button type="button"></button>`;
      document.body.appendChild(el);
    }
    el.style.cssText = boxCss(top);
    el.querySelector("span").textContent = text;
    const b = el.querySelector("button");
    b.style.cssText = btnCss;
    b.textContent = label;
    b.onclick = onClick;
  }
  function onBroken(e) {
    console.warn("保存場所のエラー", e);
    SY.fatal = e;
    emit();
    const RK = "u-reload:" + SY.id;
    let last = 0;
    try {
      last = +sessionStorage.getItem(RK) || 0;
    } catch (_) {}
    /* 未保存がなく、画面を見ているときだけ自動で開き直す（2分に1回まで） */
    if (!document.hidden && !SY.fails.size && Date.now() - last > 120000) {
      try {
        sessionStorage.setItem(RK, String(Date.now()));
      } catch (_) {}
      location.reload();
      return;
    }
    bar("u-syncerr", true, "保存先との接続が切れました。開き直すと直ります。", "開き直す", () => location.reload());
  }

  /* 書き込み1回分。full＝文書を丸ごと書く（set・delete）。丸ごと書いたら、それより前の同じ文書の失敗は不要
     once＝自動ではやり直さない（まとめ書き・トランザクション） */
  let wseq = 0;
  const lastFull = {};
  function attempt(w) {
    const tok = {};
    SY.pend.set(tok, Date.now());
    emit();
    return w.run().then(
      r => {
        SY.pend.delete(tok);
        SY.at = Date.now();
        clearTimeout(w.t);
        SY.fails.delete(w.id);
        if (w.full)
          SY.fails.forEach((f, k) => {
            if (f.path === w.path && k < w.id) {
              clearTimeout(f.t);
              SY.fails.delete(k);
            }
          });
        emit();
        return r;
      },
      e => {
        SY.pend.delete(tok);
        if (w.once || (w.full && lastFull[w.path] !== w.id)) SY.fails.delete(w.id); // やり直さないもの・あとから丸ごと書いたもの
        else {
          w.code = (e && e.code) || "error";
          w.perm = !TEMP.has(w.code);
          SY.fails.set(w.id, w);
          if (!w.perm && w.tries < RETRY_S.length) w.t = setTimeout(() => retryOne(w), RETRY_S[w.tries++] * 1000);
          console.warn("保存できませんでした", w.path, e);
        }
        if (isBroken(e)) onBroken(e);
        emit();
        throw e;
      },
    );
  }
  function retryOne(w) {
    if (!SY.fails.has(w.id)) return;
    clearTimeout(w.t);
    attempt(w).catch(() => {});
  }
  function track(path, full, run, once) {
    const w = { id: ++wseq, path, full, run, tries: 0, once: !!once };
    if (full) lastFull[path] = w.id;
    return attempt(w);
  }

  /* 読み込み（onSnapshot）を見張る。make(ok, ng) で読み込みを始めて、止める関数を返す。止まったら少し待ってつなぎ直す */
  const lsn = new Set();
  function listen(make, cb, err) {
    const L = { off: null, t: 0, n: 0, dead: false };
    L.start = () => {
      clearTimeout(L.t);
      if (L.dead) return;
      try {
        L.off && L.off();
      } catch (_) {}
      L.off = make(
        s => {
          L.n = 0;
          if (SY.lerr.delete(L)) emit();
          if (cb) cb(s);
        },
        e => {
          L.off = null;
          SY.lerr.set(L, e);
          emit();
          console.warn("読み込みが止まりました", e);
          if (err) err(e);
          if (isBroken(e)) onBroken(e);
          if (!L.dead) L.t = setTimeout(L.start, [2, 5, 15, 30, 60][Math.min(L.n++, 4)] * 1000);
        },
      );
    };
    lsn.add(L);
    L.start();
    return () => {
      L.dead = true;
      clearTimeout(L.t);
      lsn.delete(L);
      if (SY.lerr.delete(L)) emit();
      try {
        L.off && L.off();
      } catch (_) {}
    };
  }
  /* 今すぐやり直す：止まった読み込みをつなぎ直し、保存できなかったものを保存し直す（all＝あきらめたものも） */
  function redo(all) {
    lsn.forEach(L => SY.lerr.has(L) && L.start());
    SY.fails.forEach(w => (all || !w.perm) && ((w.tries = Math.min(w.tries, RETRY_S.length - 1)), retryOne(w)));
  }
  let kick = () => {};
  SY.retry = () => {
    kick(true);
    redo(true);
  };

  /* Firestore に取り付ける（1回だけ）：裏から戻ったとき・電波が戻ったとき・保存が終わらないときに通信をつなぎ直す */
  let attached = false;
  function attach(F, fs, opt) {
    if (opt && opt.id) SY.id = opt.id;
    if (attached) return;
    attached = true;
    let kickAt = 0;
    kick = async force => {
      if (!force && Date.now() - kickAt < 15000) return;
      kickAt = Date.now();
      try {
        await F.disableNetwork(fs);
      } catch (_) {}
      try {
        await F.enableNetwork(fs);
      } catch (_) {}
    };
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return void (hiddenAt = Date.now());
      if (hiddenAt && Date.now() - hiddenAt > 20000) kick();
      redo(false);
    });
    addEventListener("online", () => {
      SY.online = true;
      emit();
      F.enableNetwork(fs).catch(() => {});
      redo(false);
    });
    addEventListener("offline", () => {
      SY.online = false;
      emit();
    });
    setInterval(() => {
      if (document.hidden || !SY.online || !SY.pend.size) return;
      if (Date.now() - Math.min(...SY.pend.values()) > 20000) kick();
    }, 10000);
    /* 保存できていない変更があるときだけ、画面の下に小さく知らせる（状態表示を持たないアプリ用） */
    if (opt && opt.badge)
      SY.on(() => {
        const n = failDocs();
        bar("u-syncfail", false, n ? (SY.fails.size && [...SY.fails.values()].every(w => w.perm) ? `保存できなかった変更があります（${n}件）` : `保存できていない変更があります（${n}件）・自動で保存し直しています`) : "", "今すぐ保存", () => SY.retry());
      });
  }

  /* Firebase の関数と同じ書き方で使える版を作る（FitLife・ウリログ用） */
  function wrap(F, fs, opt) {
    attach(F, fs, opt);
    const isOpts = x => x && typeof x === "object" && typeof x.next !== "function" && !("next" in x);
    return {
      onSnapshot: (ref, ...a) => {
        const o = isOpts(a[0]) ? a.shift() : null;
        const [next, err] = a;
        return listen((ok, ng) => (o ? F.onSnapshot(ref, o, ok, ng) : F.onSnapshot(ref, ok, ng)), next, err);
      },
      setDoc: (ref, data, o) => track(ref.path, !(o && (o.merge || o.mergeFields)), () => (o ? F.setDoc(ref, data, o) : F.setDoc(ref, data))),
      updateDoc: (ref, ...a) => track(ref.path, false, () => F.updateDoc(ref, ...a)),
      deleteDoc: ref => track(ref.path, true, () => F.deleteDoc(ref)),
      /* 新しい文書：IDを先に決めてから書く（やり直しても二重にならない） */
      addDoc: (col, data) => {
        const r = F.doc(col);
        return track(r.path, true, () => F.setDoc(r, data)).then(() => r);
      },
      writeBatch: db => {
        const b = F.writeBatch(db),
          commit = b.commit.bind(b);
        b.commit = () => track(`batch-${wseq + 1}`, false, commit, true);
        return b;
      },
      runTransaction: (db, fn, o) => track(`tx-${wseq + 1}`, false, () => F.runTransaction(db, fn, o), true),
    };
  }

  return Object.assign(SY, { track, listen, attach, wrap });
})();

/* ============================================================
   ここから旧 shared/u-auth.js（ログインの処理）。ウリログ専用に取り込み
   ============================================================ */
/* ===================== ログインの共通処理：4アプリ（エンタメ管理・おかね手帳・FitLife・ウリログ）で同じファイルを使う =====================
  ふつうの <script> で読み込む（window.UAuth）。ログイン画面の見た目は各アプリのまま、処理だけをここにまとめる。
  A は Firebase の auth の関数一式（import した firebase-auth.js）

  UAuth.STANDALONE          … ホーム画面のアイコンから開いているか
  UAuth.IN_LINE             … LINE の中のブラウザで開いているか（Googleログインが使えない）
  UAuth.appUrl()            … このアプリのURL（? や # を除いたもの）
  UAuth.normEmail(s)        … メールアドレスを小文字・前後の空白なしにそろえる
  UAuth.emailOk(s)          … メールアドレスの形になっているか
  UAuth.msg(err, 上書き)     … ログインのエラーを、やさしい日本語にする（アプリごとに文を上書きできる）
  UAuth.google(auth, A)     … Googleでログイン。ポップアップが使えないとき（ホーム画面から開いたときなど）は画面を切り替えてログイン
                               自分で閉じたときは false。それ以外の失敗はエラーを投げる
  UAuth.sendLink(auth, A, email, url, key)   … ログイン用のリンクをメールで送る（送ったアドレスを端末に覚えておく）
  UAuth.finishLink(auth, A, email, link, key) … メールのリンクでログインを終える（覚えたアドレスを消して、URLをもとに戻す）
  UAuth.setPassword(A, user, pw)              … パスワードを作る・変える */
window.UAuth = (() => {
  const STANDALONE = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const IN_LINE = / Line\//i.test(navigator.userAgent);
  const appUrl = () => location.origin + location.pathname;
  const normEmail = s => String(s || "").trim().toLowerCase();
  const emailOk = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const ERR = {
    "auth/invalid-email": "メールアドレスの形がちがうみたい",
    "auth/missing-password": "パスワードを入れてね",
    "auth/weak-password": "パスワードは6文字以上にしてね",
    "auth/email-already-in-use": "このメールアドレスはもう登録されているよ。「ログイン」から入ってね",
    "auth/invalid-credential": "メールアドレスかパスワードがちがうみたい",
    "auth/wrong-password": "メールアドレスかパスワードがちがうみたい",
    "auth/user-not-found": "メールアドレスかパスワードがちがうみたい",
    "auth/too-many-requests": "何度も失敗したので、少し時間をおいてね",
    "auth/network-request-failed": "ネットにつながっていないみたい",
    "auth/operation-not-allowed": "Firebaseで、このログイン方法がまだオンになっていないみたい",
    "auth/unauthorized-domain": "このURLがFirebaseの「承認済みドメイン」に入っていないみたい",
    "auth/unauthorized-continue-uri": "このURLがFirebaseの「承認済みドメイン」に入っていないみたい",
    "auth/invalid-action-code": "このリンクは使えません（期限切れか使用ずみ）。もう一度メールを送ってね",
    "auth/expired-action-code": "リンクの期限が切れています。もう一度メールを送ってね",
    "auth/quota-exceeded": "今日はメールを送れる回数の上限です。明日また試すか、Googleでログインしてね",
    "auth/account-exists-with-different-credential": "このメールアドレスは別の方法で登録ずみです。メールのリンクでログインしてね",
    "auth/requires-recent-login": "安全のため、一度ログアウトして、もう一度ログインしてから設定してね",
  };
  const msg = (e, over) => (over && over[e?.code]) || ERR[e?.code] || `うまくいかなかったよ（${e?.code || e?.message || "不明"}）`;
  async function google(auth, A) {
    const pv = new A.GoogleAuthProvider();
    pv.setCustomParameters({ prompt: "select_account" });
    try {
      await A.signInWithPopup(auth, pv);
      return true;
    } catch (e) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e?.code)) {
        await A.signInWithRedirect(auth, pv);
        return true;
      }
      if (["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(e?.code)) return false;
      throw e;
    }
  }
  async function sendLink(auth, A, email, url, key) {
    email = normEmail(email);
    await A.sendSignInLinkToEmail(auth, email, { url: url || appUrl(), handleCodeInApp: true });
    try {
      localStorage.setItem(key, email);
    } catch (_) {}
    return email;
  }
  async function finishLink(auth, A, email, link, key) {
    await A.signInWithEmailLink(auth, normEmail(email), link);
    try {
      localStorage.removeItem(key);
    } catch (_) {}
    if (location.search || location.hash) history.replaceState(null, "", appUrl());
  }
  async function setPassword(A, user, pw) {
    if ((user.providerData || []).some(p => p.providerId === "password")) await A.updatePassword(user, pw);
    else await A.linkWithCredential(user, A.EmailAuthProvider.credential(user.email, pw));
  }
  return { STANDALONE, IN_LINE, appUrl, normEmail, emailOk, msg, google, sendLink, finishLink, setPassword };
})();

/* ============================================================
   ここから core.js 本体
   ============================================================ */
"use strict";
/* ウリログ：共通の道具（設定・アイコン・カテゴリ・小さな関数）と状態
   ファイルの分け方：core.js（共通の道具・状態）→ 各機能 → events.js（ボタン）→ boot.js（Firebase につないで起動）
   どのファイルの関数・変数も、ほかのファイルからそのまま使える（ふつうの <script> で順に読み込む） */

/* =============== Firebaseの設定（Firebaseの画面からコピーしたものを入れる） =============== */
const firebaseConfig = {
  apiKey: "AIzaSyDZLO469EfTGmtO1_J6-K3hE1zK13WmElg",
  authDomain: "futari-biyori-edaa5.firebaseapp.com",
  projectId: "futari-biyori-edaa5",
  storageBucket: "futari-biyori-edaa5.firebasestorage.app",
  messagingSenderId: "1023567033337",
  appId: "1:1023567033337:web:c17437a09a1719d6360328"
};

const V = "12.15.0";
const $app = document.getElementById("app"), $nav = document.getElementById("nav"), $layer = document.getElementById("layer");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);

/* ---------- アイコン ---------- */
const IC = {
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.3 4.5 6.8 4.5c2.1 0 3.6 1.2 5.2 3.1 1.6-1.9 3.1-3.1 5.2-3.1 3.5 0 5.4 3.5 4.1 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" stroke-linejoin="round"/></svg>',
  logo: '<svg viewBox="0 0 24 24"><path d="M9 18.5s-6-3.7-7.4-7.3C.6 8.6 2.1 5.8 4.9 5.8c1.7 0 2.9 1 4.1 2.5 1.3-1.5 2.5-2.5 4.1-2.5 2.8 0 4.3 2.8 3.3 5.4C15 14.8 9 18.5 9 18.5z" fill="#f4a3b8"/><path d="M16.5 20.5s-4.5-2.8-5.6-5.5c-.8-2 .4-4.1 2.5-4.1 1.3 0 2.2.7 3.1 1.9 1-1.2 1.9-1.9 3.1-1.9 2.1 0 3.3 2.1 2.5 4.1-1.1 2.7-5.6 5.5-5.6 5.5z" fill="#b8a6e6" stroke="#fff" stroke-width="1.2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/></svg>',
  home: '<svg viewBox="0 0 24 24" stroke-linejoin="round" stroke-linecap="round"><path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.5h-6v5.5H5.5A1.5 1.5 0 0 1 4 19z"/></svg>',
  memo: '<svg viewBox="0 0 24 24" stroke-linejoin="round" stroke-linecap="round"><rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M4 15.5l4.5-4 3.5 3 2.5-2 5.5 4.5"/><circle cx="15" cy="8" r="1.6"/></svg>',
  uri: '<svg viewBox="0 0 24 24" stroke-linejoin="round" stroke-linecap="round"><path d="M6.6 8.6 5.2 4.6l4.1 2.1M17.4 8.6l1.4-4-4.1 2.1"/><ellipse cx="12" cy="13.2" rx="7.6" ry="7"/><ellipse cx="12" cy="15.6" rx="3.3" ry="2.4"/><path d="M8.9 11.6h.01M15.1 11.6h.01M11 15.6h.01M13 15.6h.01" stroke-width="2.4"/></svg>',
  cal: '<svg viewBox="0 0 24 24" stroke-linejoin="round" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="4"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M12 17.6s-2.6-1.6-3.2-3.1c-.4-1.1.3-2.1 1.3-2.1.8 0 1.3.5 1.9 1.2.6-.7 1.1-1.2 1.9-1.2 1 0 1.7 1 1.3 2.1-.6 1.5-3.2 3.1-3.2 3.1z" fill="currentColor" stroke="none"/></svg>'
};

/* ---------- カテゴリ ---------- */
const CATS = [
  { id:"cafe",   e:"☕", n:"カフェ",     c:"var(--peach-l)" },
  { id:"food",   e:"🍝", n:"ごはん",     c:"var(--butter-l)" },
  { id:"play",   e:"🎡", n:"あそび",     c:"var(--lav-l)" },
  { id:"nature", e:"🌿", n:"しぜん",     c:"var(--mint-l)" },
  { id:"shop",   e:"🛍️", n:"おかいもの", c:"var(--pink-l)" },
  { id:"trip",   e:"🧳", n:"りょこう",   c:"#e8f1fb" },
  { id:"event",  e:"🎪", n:"イベント",   c:"#fbeef6" },
  { id:"other",  e:"✨", n:"その他",     c:"#f5f0f3" }
];
const catOf = id => CATS.find(c => c.id === id) || CATS[CATS.length - 1];
/* やりたいことリストの種類（kind がない候補は「行きたい」） */
const KINDS = [
  { id:"go",  n:"行きたい", e:"📍", c:"var(--pink-l)",   done:"行った", not:"行ってない", th:"場所の名前",         ph:"例：海の見えるカフェ" },
  { id:"do",  n:"やりたい", e:"✨", c:"var(--lav-l)",    done:"やった", not:"やってない", th:"やりたいこと",       ph:"例：おそろいのマグを買う" },
  { id:"eat", n:"食べたい", e:"🍽", c:"var(--butter-l)", done:"食べた", not:"食べてない", th:"食べたいもの・お店", ph:"例：ふわふわパンケーキ" },
  { id:"see", n:"見たい",   e:"🎬", c:"#e8f1fb",         done:"見た",   not:"見てない",   th:"見たいもの",         ph:"例：話題の映画" }
];
const kindOf = p => KINDS.find(k => k.id === (p?.kind || "go")) || KINDS[0];
/* 一覧などに出すアイコン：行きたいはカテゴリ、それ以外は種類 */
const iconOf = p => kindOf(p).id === "go" ? catOf(p.cat) : kindOf(p);

/* ---------- ちょっとした道具 ---------- */
/* ---------- どんぐりアイコン（🌰は栗なので自前で描く） ---------- */
function acornSvg(gold){
  const c = gold ? ["#f6c945", "#d9a520", "#fff3c4", "#b8862a", "#94691c", "#d8ad55"] : ["#c98448", "#a5622f", "#fff", "#8b6239", "#6e4b2b", "#a57b4f"];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 48"><path d="M8 19 C8 33 14 44 20 46 C26 44 32 33 32 19 Z" fill="${c[0]}"/><path d="M24 19 C26 30 24 40 20 46 C26 44 32 33 32 19 Z" fill="${c[1]}" opacity=".6"/><ellipse cx="14.5" cy="27" rx="2.6" ry="6" fill="${c[2]}" opacity=".45"/><path d="M5 19.5 C5 11 12 7 20 7 C28 7 35 11 35 19.5 C35 22 31 23.5 20 23.5 C9 23.5 5 22 5 19.5 Z" fill="${c[3]}"/><path d="M5.3 20 C6 22.2 10 23.5 20 23.5 C30 23.5 34 22.2 34.7 20 C33 21 28 21.5 20 21.5 C12 21.5 7 21 5.3 20 Z" fill="${c[4]}"/><g fill="${c[5]}"><circle cx="11" cy="15" r="1.3"/><circle cx="16" cy="12" r="1.3"/><circle cx="21" cy="11" r="1.3"/><circle cx="26" cy="12.5" r="1.3"/><circle cx="30" cy="16" r="1.3"/><circle cx="14" cy="18" r="1.3"/><circle cx="19.5" cy="16" r="1.3"/><circle cx="25" cy="17.5" r="1.3"/></g><path d="M20 7.5 C20 4.5 21 2.5 24 1.5" stroke="${c[4]}" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>`;
}
const AC = `<span class="acn">${acornSvg()}</span>`;

function toast(msg){ const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2300); }
function openSheet(html){ $layer.innerHTML = `<div class="ov" data-a="ovclose"><div class="sheet" role="dialog"><div class="grab"></div>${html}</div></div>`; }
function closeSheet(){ $layer.innerHTML = ""; }
/* 同じシートを開いたまま中身だけ入れかえる（高さ固定・スクロール位置そのまま。おみせ・おへやの切りかえ用） */
function openSheetK(key, html){
  const cur = $layer.querySelector(`.sheet[data-k="${key}"]`);
  if (!cur) { $layer.innerHTML = `<div class="ov" data-a="ovclose"><div class="sheet tall" data-k="${key}" role="dialog"><div class="grab"></div>${html}</div></div>`; return; }
  const top = cur.scrollTop, cx = [...cur.querySelectorAll(".chips,.seg")].map(c => c.scrollLeft);
  cur.innerHTML = `<div class="grab"></div>${html}`;
  cur.scrollTop = top; cur.querySelectorAll(".chips,.seg").forEach((c, i) => { c.scrollLeft = cx[i] || 0; });
}
/* 消す前の確認（開いている画面の上に重ねて出す）。「やめる」が上、「消す」が下 */
function askConfirm(title, text, okLabel = "消す"){
  return new Promise(res => {
    const o = document.createElement("div"); o.className = "cfm";
    o.innerHTML = `<div class="box" role="alertdialog"><h4>${title}</h4>${text ? `<p>${text}</p>` : ""}<button class="btn ghost block" data-c="0">やめる</button><button class="btn danger fill block" data-c="1">${okLabel}</button></div>`;
    o.addEventListener("click", e => {
      e.stopPropagation();
      const b = e.target.closest("[data-c]");
      if (!b && e.target !== o) return;
      o.remove(); res(b?.dataset.c === "1");
    });
    document.body.appendChild(o);
  });
}
function today(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
/* 写真を小さくしてJPEGの文字データにする（Firestoreに直接入れるため） */
function loadImg(file){
  return new Promise((res, rej) => { const u = URL.createObjectURL(file), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error("画像を読みこめませんでした")); }; im.src = u; });
}
function shrink(im, maxSide, maxBytes){
  let side = maxSide, q = 0.8, out = "";
  for (let i = 0; i < 8; i++) {
    const r = Math.min(1, side / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(im.naturalWidth * r); c.height = Math.round(im.naturalHeight * r);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    out = c.toDataURL("image/jpeg", q);
    if (out.length <= maxBytes) return out;
    if (q > 0.55) q -= 0.1; else side = Math.round(side * 0.8);
  }
  return out;
}
/* 日付の計算（記念日） */
const ymd = s => { const [y, m, d] = String(s).split("-").map(Number); return Date.UTC(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((ymd(b) - ymd(a)) / 86400000);
const addDays = (s, n) => { const t = new Date(ymd(s) + n * 86400000); return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,"0")}-${String(t.getUTCDate()).padStart(2,"0")}`; };
function fmtDate(s){ if(!s) return ""; const [y,m,d] = String(s).split("-"); return `${y}年${+m}月${+d}日`; }
function ms(t){ return t && t.toMillis ? t.toMillis() : (typeof t === "number" ? t : Date.now()); }
/* ログインのエラー文・端末の判定・メールアドレスの整え方は共通の shared/u-auth.js */
const authMsg = e => UAuth.msg(e);

const { appUrl, STANDALONE, IN_LINE, normEmail, emailOk } = UAuth;


/* ---------- Firebase の関数（boot.js でつないだときに入る） ---------- */
let initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, isSignInWithEmailLink;
let FS, getFirestore, doc, collection, getDoc, getDocs, serverTimestamp, arrayUnion, deleteField, increment;
let onSnapshot, setDoc, updateDoc, addDoc, deleteDoc, writeBatch;
let AU, fbApp, auth, db; // AU＝firebase-auth の関数一式

/* メールのリンクから開かれたとき：リンクを覚えておき、送ったアドレスが分かればそのままログイン（boot.js で確認） */
const LOGIN = { link: null, sent: false };
async function finishEmailLink(email, link){
  await UAuth.finishLink(auth, AU, email, link, "futari_email");
  LOGIN.link = null; LOGIN.sent = false;
}

/* ---------- 状態 ---------- */
const S = {
  user:null, profile:null, room:null, roomId:null, places:[], dates:[], quiz:{}, qa:{}, tickets:[], letters:[], pet:null, needRules:false, tkTab:"got", extraErr:null, subs:[], noteEdit:null,
  calY:null, calM:null, calSel:null, qv:null,
  tab:"home", kind:"all", cat:"all", who:"all", sort:"new", q:"",
  authMode:"login", busy:false
};
const me = () => S.user?.uid;
const partnerUid = () => (S.room?.members || []).find(u => u !== me());
const nameOf = uid => (S.room?.names || {})[uid] || (uid === me() ? (S.profile?.name || "わたし") : "あいて");
const isPaired = () => (S.room?.members || []).length >= 2;
const votesOf = p => Object.keys(p.votes || {}).filter(u => p.votes[u] && (S.room?.members || []).includes(u));
const loveOf = (p, u) => { const x = (p.votes || {})[u]; return x === true ? 1 : (+x || 0); };
const loveSum = p => votesOf(p).reduce((n, u) => n + loveOf(p, u), 0);
const isBoth = p => isPaired() && votesOf(p).length >= 2;
const myEmail = () => normEmail(S.user?.email);
const inviteText = email => `ウリログを使おう♡\nこのURLをひらいて、${email} でログインしてね。\n${appUrl()}?openExternalBrowser=1`;

function stopSubs(){ S.subs.forEach(f => { try { f(); } catch {} }); S.subs = []; }

