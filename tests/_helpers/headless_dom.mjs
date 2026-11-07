/**
 * Zero-dependency Headless DOM Harness for Node.js (Node >= 22.19.0)
 *
 * Implements lightweight MockElement, MockDocument, and MockClassList to support
 * automated UI testing of AgentFusion web modules (`web/js/views/group.js`, `web/js/app.js`,
 * `web/js/store.js`) under `node --test` with ZERO external npm dependencies.
 */

export class MockClassList {
  constructor(el) {
    this.el = el;
  }
  get _classes() {
    return (this.el.className || "").trim().split(/\s+/).filter(Boolean);
  }
  contains(cls) {
    return this._classes.includes(cls);
  }
  add(...classes) {
    const set = new Set(this._classes);
    for (const c of classes) {
      if (c) set.add(c);
    }
    this.el.className = Array.from(set).join(" ");
  }
  remove(...classes) {
    const removeSet = new Set(classes);
    this.el.className = this._classes.filter((c) => !removeSet.has(c)).join(" ");
  }
  toggle(cls, force) {
    const has = this.contains(cls);
    const want = force !== undefined ? force : !has;
    if (want) this.add(cls);
    else this.remove(cls);
    return want;
  }
}

const VOID_ELEMENTS = new Set([
  "AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META",
  "PARAM", "SOURCE", "TRACK", "WBR", "CIRCLE", "PATH", "RECT", "ELLIPSE", "LINE",
  "POLYGON", "POLYLINE", "SVG", "G", "TEXT"
]);

export function parseHTMLToNodes(html, ownerDoc) {
  const root = new MockElement("FRAGMENT", ownerDoc);
  let current = root;
  const tagRe = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9:-]+)((?:\s+[a-zA-Z0-9:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>|([^<]+)/g;
  let match;

  while ((match = tagRe.exec(html)) !== null) {
    const [full, isClosing, tagName, attrString, isSelfClosing, textContent] = match;
    if (full.startsWith("<!--")) continue;
    if (textContent !== undefined) {
      if (textContent.trim()) {
        const textNode = new MockTextNode(textContent, ownerDoc);
        current.appendChild(textNode);
      }
      continue;
    }

    const tag = tagName.toUpperCase();
    if (isClosing) {
      let p = current;
      while (p && p.tagName !== tag && p !== root) {
        p = p.parentElement;
      }
      if (p && p !== root) {
        current = p.parentElement || root;
      }
    } else {
      const el = new MockElement(tag, ownerDoc);
      if (attrString) {
        const attrRe = /([a-zA-Z0-9:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        let attrMatch;
        while ((attrMatch = attrRe.exec(attrString)) !== null) {
          const attrName = attrMatch[1];
          const attrVal =
            attrMatch[2] !== undefined
              ? attrMatch[2]
              : attrMatch[3] !== undefined
              ? attrMatch[3]
              : attrMatch[4] !== undefined
              ? attrMatch[4]
              : "";
          el.setAttribute(attrName, attrVal);
        }
      }
      current.appendChild(el);
      const isVoid = isSelfClosing || VOID_ELEMENTS.has(tag);
      if (!isVoid) {
        current = el;
      }
    }
  }
  return root.children;
}

export class MockNode extends EventTarget {
  constructor(ownerDoc) {
    super();
    this.ownerDocument = ownerDoc;
    this.parentElement = null;
  }
}

export class MockTextNode extends MockNode {
  constructor(text, ownerDoc) {
    super(ownerDoc);
    this.nodeType = 3;
    this.textContent = text;
  }
}

export class MockElement extends MockNode {
  constructor(tagName = "DIV", ownerDoc = null) {
    super(ownerDoc);
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this._className = "";
    this._innerHTML = "";
    this._value = "";
    this.classList = new MockClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.onclick = null;
    this.onkeydown = null;
    this.oninput = null;
    this.onblur = null;
    this.scrollHeight = 100;
    this.scrollTop = 0;
    this.clientHeight = 100;
  }

  get className() {
    return this._className;
  }
  set className(val) {
    this._className = String(val || "");
    this.attributes.set("class", this._className);
  }

  get id() {
    return this.attributes.get("id") || "";
  }
  set id(val) {
    if (val) this.attributes.set("id", val);
    else this.attributes.delete("id");
  }

  get value() {
    return this._value;
  }
  set value(val) {
    this._value = String(val ?? "");
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent || "").join("");
  }
  set textContent(val) {
    this.children = [];
    this.childNodes = [];
    this.appendChild(new MockTextNode(String(val), this.ownerDocument));
  }

  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(html) {
    this._innerHTML = String(html || "");
    this.children = [];
    this.childNodes = [];
    const nodes = parseHTMLToNodes(this._innerHTML, this.ownerDocument);
    for (const node of nodes) {
      this.appendChild(node);
    }
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  setAttribute(name, val) {
    const sVal = String(val);
    this.attributes.set(name, sVal);
    if (name === "class") this._className = sVal;
    if (name === "id") this.id = sVal;
    if (name.startsWith("data-")) {
      const raw = name.slice(5);
      const camel = raw.replace(/-([a-z0-9])/g, (_, g) => g.toUpperCase());
      this.dataset[camel] = sVal;
    }
    if (name === "disabled") this.disabled = true;
    if (name === "hidden") this.hidden = true;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "class") this._className = "";
    if (name === "disabled") this.disabled = false;
    if (name === "hidden") this.hidden = false;
  }

  appendChild(child) {
    child.parentElement = this;
    if (child.nodeType === 1) this.children.push(child);
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const cIdx = this.children.indexOf(child);
    if (cIdx !== -1) this.children.splice(cIdx, 1);
    const nIdx = this.childNodes.indexOf(child);
    if (nIdx !== -1) this.childNodes.splice(nIdx, 1);
    child.parentElement = null;
    return child;
  }

  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }

  matches(sel) {
    sel = sel.trim();
    const attrMatch = /^\[([a-zA-Z0-9:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/.exec(sel);
    if (attrMatch) {
      const attr = attrMatch[1];
      const val = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
      if (!this.attributes.has(attr)) return false;
      if (val !== undefined) return this.attributes.get(attr) === val;
      return true;
    }

    if (sel.startsWith("#")) {
      return this.attributes.get("id") === sel.slice(1);
    }

    if (sel.startsWith(".")) {
      const classes = sel.slice(1).split(".").filter(Boolean);
      return classes.every((c) => this.classList.contains(c));
    }

    if (/^[a-zA-Z0-9:-]+$/.test(sel)) {
      return this.tagName.toLowerCase() === sel.toLowerCase();
    }

    const tagCompound = /^([a-zA-Z0-9:-]+)(\.[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|\[.*\])+$/.exec(sel);
    if (tagCompound) {
      const tag = tagCompound[1];
      if (this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const rest = sel.slice(tag.length);
      return this.matches(rest);
    }

    const classAttr = /^(\.[a-zA-Z0-9_-]+)(\[.+\])$/.exec(sel);
    if (classAttr) {
      return this.matches(classAttr[1]) && this.matches(classAttr[2]);
    }

    return false;
  }

  closest(sel) {
    let el = this;
    while (el && el.nodeType === 1) {
      if (typeof el.matches === "function" && el.matches(sel)) return el;
      el = el.parentElement;
    }
    return null;
  }

  querySelector(sel) {
    sel = sel.trim();
    const parts = sel.split(/\s+/);
    if (parts.length === 1) {
      for (const child of this.children) {
        if (child.matches(sel)) return child;
        const found = child.querySelector(sel);
        if (found) return found;
      }
      return null;
    }
    const [first, ...rest] = parts;
    const restSel = rest.join(" ");
    const matchesFirst = this.querySelectorAll(first);
    for (const m of matchesFirst) {
      const target = m.querySelector(restSel);
      if (target) return target;
    }
    return null;
  }

  querySelectorAll(sel) {
    sel = sel.trim();
    const parts = sel.split(/\s+/);
    if (parts.length > 1) {
      const [first, ...rest] = parts;
      const restSel = rest.join(" ");
      const matchesFirst = this.querySelectorAll(first);
      const results = [];
      for (const m of matchesFirst) {
        results.push(...m.querySelectorAll(restSel));
      }
      return results;
    }
    const results = [];
    for (const child of this.children) {
      if (child.matches(sel)) results.push(child);
      results.push(...child.querySelectorAll(sel));
    }
    return results;
  }

  dispatchEvent(event) {
    if (event.type === "click" && this.disabled) {
      return false;
    }
    if (event.type === "click" && typeof this.onclick === "function") {
      this.onclick(event);
    }
    super.dispatchEvent(event);
    if (event.bubbles && this.parentElement && !event.cancelBubble) {
      this.parentElement.dispatchEvent(event);
    }
    return true;
  }

  click() {
    const ev = new Event("click", { bubbles: true, cancelable: true });
    this.dispatchEvent(ev);
  }

  scrollTo(xOrOpts, y) {
    if (typeof xOrOpts === "object" && xOrOpts !== null) {
      const { top = 0, left = 0 } = xOrOpts;
      this.scrollTop = typeof top === "number" ? top : 0;
      this.scrollLeft = typeof left === "number" ? left : 0;
    } else if (typeof xOrOpts === "number") {
      this.scrollLeft = xOrOpts;
      this.scrollTop = typeof y === "number" ? y : 0;
    }
  }
}

export class MockDocument extends EventTarget {
  constructor() {
    super();
    this.documentElement = new MockElement("HTML", this);
    this.body = new MockElement("BODY", this);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag) {
    return new MockElement(tag, this);
  }
  querySelector(sel) {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

export function setupHeadlessDOM() {
  const prevWindow = globalThis.window;
  const prevDoc = globalThis.document;
  const prevLocalStorage = globalThis.localStorage;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;

  const doc = new MockDocument();
  globalThis.window = globalThis;
  globalThis.document = doc;
  globalThis.localStorage = {
    _data: new Map(),
    getItem(k) { return this._data.get(k) ?? null; },
    setItem(k, v) { this._data.set(k, String(v)); },
    removeItem(k) { this._data.delete(k); },
    clear() { this._data.clear(); },
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  return {
    document: doc,
    teardown() {
      globalThis.window = prevWindow;
      globalThis.document = prevDoc;
      globalThis.localStorage = prevLocalStorage;
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCaf;
    },
  };
}
