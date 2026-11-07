/*
 * IR Remote Card for Home Assistant
 * https://github.com/sargeantpepper/IRRemoteCustomCard
 *
 * A remote for IR-controlled devices (built for a stereo amplifier), sending
 * commands through an ESPHome or Tasmota IR blaster. Styled to match the
 * TrueNAS / Proxmox VE cards: badge header, status pill, tinted collapsible panels.
 * Includes a visual editor.
 */
const CARD_VERSION = '1.2.0';

const SECTION_KEYS = ['power', 'volume', 'inputs', 'adjust', 'buttons'];
const SECTION_TITLES = { power: 'Power', volume: 'Volume', inputs: 'Inputs', adjust: 'Tone', buttons: 'Extras' };
const SECTION_ICONS = {
  power: 'mdi:power', volume: 'mdi:volume-high', inputs: 'mdi:import', adjust: 'mdi:tune-vertical', buttons: 'mdi:dots-grid',
};
// Keys on a command that control how it is sent, not what is sent.
const REPEAT_KEYS = ['hold_repeat', 'repeat_delay', 'repeat_interval', 'times', 'gap'];
const OPTION_DEFAULTS = {
  repeat_delay: 400, repeat_interval: 180, unmute_on_volume: true, input_powers_on: true, macro_delay: 0,
  inputs_columns: 3, buttons_columns: 3, background_opacity: 100, glass_background: false, debug: false, power_threshold: 5,
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ENTITY_CMD_RE = /^(button|input_button|script|scene)\.[a-z0-9_]+$/;
const NUM_RE = /^(0x[0-9a-f]+|-?\d+)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v === undefined || v === null || v === '' || (isObj(v) && !Object.keys(v).length);
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let a = o;
  for (let i = 0; i < ks.length - 1; i++) {
    if (a[ks[i]] == null) a[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
    a = a[ks[i]];
  }
  const last = ks[ks.length - 1];
  if (v === undefined && !Array.isArray(a)) delete a[last];
  else a[last] = v;
}
const toInt = (v) => (typeof v === 'string' && NUM_RE.test(v.trim()) ? parseInt(v.trim(), v.trim().toLowerCase().startsWith('0x') ? 16 : 10) : v);

/* ======================= sending ======================= */

function splitOpts(cmd) {
  const base = {};
  const opts = {};
  for (const [k, v] of Object.entries(cmd)) (REPEAT_KEYS.includes(k) ? opts : base)[k] = v;
  return { base, opts };
}

/** One command (string or object, no repeat keys) -> { domain, service, data } */
function resolveCall(cmd, transport) {
  if (cmd == null || cmd === '') throw new Error('No command set');
  const t = transport || {};
  const type = (t.type || 'esphome').toLowerCase();
  if (typeof cmd === 'string') {
    if (type === 'text' && !ENTITY_CMD_RE.test(cmd)) return resolveCall({ code: cmd }, transport);
    const domain = cmd.split('.')[0];
    if (domain === 'button' || domain === 'input_button') return { domain, service: 'press', data: { entity_id: cmd } };
    if (domain === 'script' || domain === 'scene') return { domain, service: 'turn_on', data: { entity_id: cmd } };
    throw new Error(`Don't know how to send "${cmd}"`);
  }
  const act = cmd.action || cmd.service || cmd.perform_action;
  if (act) {
    if (!String(act).includes('.')) throw new Error(`Action "${act}" should look like domain.action`);
    const [domain, service] = String(act).split('.');
    const data = { ...(cmd.data || cmd.service_data || {}) };
    if (cmd.target) Object.assign(data, cmd.target);
    return { domain, service, data };
  }
  if (cmd.entity !== undefined) return resolveCall(cmd.entity, transport);

  if (type === 'text') {
    if (!t.entity) throw new Error('Choose the text entity that sends IR codes (transport.entity)');
    if (cmd.code === undefined || cmd.code === null || cmd.code === '') throw new Error('No code set for this button');
    const domain = t.entity.split('.')[0] === 'input_text' ? 'input_text' : 'text';
    return { domain, service: 'set_value', data: { entity_id: t.entity, value: `${t.prefix ?? ''}${cmd.code}${t.suffix ?? ''}` } };
  }
  if (type === 'esphome') {
    if (cmd.raw !== undefined) {
      if (!t.raw_service) throw new Error('Set "ESPHome raw send action" (transport.raw_service) to send raw codes');
      const { raw, ...rest } = cmd;
      const code = Array.isArray(raw) ? raw.map(Number) : String(raw).split(/[\s,]+/).filter(Boolean).map(Number);
      if (code.some(isNaN)) throw new Error('Raw code must be numbers, e.g. 9000, -4500, 560, -560');
      const [domain, service] = t.raw_service.split('.');
      return { domain, service, data: { ...(t.raw_data || {}), ...rest, code } };
    }
    const svc = cmd.service_override || t.service;
    if (!svc) throw new Error('Set the ESPHome send action (transport.service), e.g. esphome.ir_blaster_send_nec');
    const [domain, service] = svc.split('.');
    const data = {};
    for (const [k, v] of Object.entries({ ...(t.data || {}), ...cmd })) {
      if (k === 'service_override') continue;
      data[k] = toInt(v);
    }
    return { domain, service, data };
  }
  if (type === 'tasmota') {
    if (!t.topic && !t.full_topic) throw new Error('Set the Tasmota device topic (transport.topic)');
    const topic = t.full_topic || `cmnd/${t.topic}/IRSend`;
    let payload;
    if (cmd.raw !== undefined) payload = String(cmd.raw);
    else {
      const p = {};
      const map = { protocol: 'Protocol', bits: 'Bits', data: 'Data', data_lsb: 'DataLSB', repeat: 'Repeat' };
      for (const [k, v] of Object.entries({ ...(t.data || {}), ...cmd })) {
        const key = map[k.toLowerCase()] || k;
        if (key === 'Data' && typeof v === 'number') p[key] = `0x${v.toString(16).toUpperCase()}`;
        else if (key === 'Bits' || key === 'Repeat') p[key] = toInt(v);
        else p[key] = v;
      }
      payload = JSON.stringify(p);
    }
    return { domain: 'mqtt', service: 'publish', data: { topic, payload } };
  }
  throw new Error('No IR blaster configured: use a button, script or action for this command');
}

/** Send a command, sequence or list, honouring times/gap. */
async function sendCommand(hass, cmd, config) {
  if (cmd == null || cmd === '') throw new Error('No command set');
  if (Array.isArray(cmd)) {
    for (const step of cmd) {
      if (isObj(step) && Object.keys(step).length === 1 && 'delay' in step) await sleep(Number(step.delay) || 0);
      else {
        await sendCommand(hass, step, config);
        if (config.macro_delay) await sleep(config.macro_delay);
      }
    }
    return;
  }
  const { base, opts } = isObj(cmd) ? splitOpts(cmd) : { base: cmd, opts: {} };
  const times = Math.max(1, Math.min(20, parseInt(opts.times, 10) || 1));
  for (let i = 0; i < times; i++) {
    if (isObj(base) && base.sequence !== undefined) await sendCommand(hass, base.sequence, config);
    else {
      const call = resolveCall(base, config.transport);
      if (config.debug) console.info('[ir-remote-card]', call.domain, call.service, call.data);
      await hass.callService(call.domain, call.service, call.data);
      const t = config.transport || {};
      if (t.type === 'text' && call.service === 'set_value' && call.data.entity_id === t.entity && !isEmpty(t.reset_value)) {
        await sleep(Number(t.reset_delay ?? 100));
        await hass.callService(call.domain, 'set_value', { entity_id: t.entity, value: String(t.reset_value) });
      }
    }
    if (i < times - 1) await sleep(Number(opts.gap ?? 100));
  }
}

/** Whether a command repeats while held: its own setting, else the default for where it sits. */
function holdDefault(path, config) {
  if (path === 'commands.volume_up' || path === 'commands.volume_down') return true;
  const m = path.match(/^adjust\.(\d+)\.(up|down)$/);
  if (m) return config.adjust?.[m[1]]?.repeat !== false;
  const b = path.match(/^buttons\.(\d+)\.command$/);
  if (b) return !!config.buttons?.[b[1]]?.hold_repeat;
  return false;
}
function holdFor(path, config) {
  const cmd = getPath(config, path);
  if (isObj(cmd) && cmd.hold_repeat !== undefined) return !!cmd.hold_repeat;
  return holdDefault(path, config);
}

/* ======================= card ======================= */

class IrRemoteCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hold = null;
    this._sig = '';
    this._collapsed = {};
    this._local = {};
  }

  static getConfigElement() {
    return document.createElement('ir-remote-card-editor');
  }

  static getStubConfig() {
    return {
      name: 'Stereo Amplifier',
      icon: 'mdi:amplifier',
      transport: { type: 'esphome', service: 'esphome.ir_blaster_send_nec' },
      commands: {
        power: { address: '0x0', command: '0x0' },
        volume_up: { address: '0x0', command: '0x0' },
        volume_down: { address: '0x0', command: '0x0' },
        mute: { address: '0x0', command: '0x0' },
      },
      inputs: [
        { name: 'CD', icon: 'mdi:disc', command: { address: '0x0', command: '0x0' } },
        { name: 'Tuner', icon: 'mdi:radio', command: { address: '0x0', command: '0x0' } },
        { name: 'Aux', icon: 'mdi:audio-input-rca', command: { address: '0x0', command: '0x0' } },
      ],
    };
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');
    const t = config.transport || {};
    const type = (t.type || 'esphome').toLowerCase();
    if (!['esphome', 'tasmota', 'text', 'none'].includes(type)) {
      throw new Error(`transport.type must be esphome, tasmota, text or none (got "${t.type}")`);
    }
    this._config = {
      name: 'Stereo Amplifier',
      icon: 'mdi:amplifier',
      sections: SECTION_KEYS,
      ...OPTION_DEFAULTS,
      ...config,
      transport: { ...t, type },
      commands: config.commands || {},
      inputs: config.inputs || [],
      adjust: config.adjust || [],
      buttons: config.buttons || [],
    };
    this._storeKey = `ir-remote-card:${config.storage_key || this._config.name}`;
    try {
      this._local = JSON.parse(localStorage.getItem(this._storeKey) || '{}') || {};
    } catch (e) {
      this._local = {};
    }
    this._collapsed = {};
    for (const s of config.collapsed || []) this._collapsed[s] = true;
    if (this._local.collapsed) Object.assign(this._collapsed, this._local.collapsed);
    this._sig = '';
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const c = this._config;
    if (!c) return;
    const ids = [c.power_entity, c.input_entity, c.volume_entity, c.mute_entity].filter(Boolean);
    const sig = ids.map((id) => {
      const s = hass.states[id];
      return s ? `${s.state}|${s.attributes.min}|${s.attributes.max}` : 'x';
    }).join(';') + `#${hass.themes?.darkMode}`;
    if (sig === this._sig) return;
    this._sig = sig;
    if (this._hold) { this._pendingRender = true; return; }
    this._render();
  }

  getCardSize() {
    return 3 + Math.ceil((this._config?.inputs?.length || 0) / 3) + (this._config?.adjust?.length || 0);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: 'auto' };
  }

  /* ---------------- state ---------------- */

  _save() {
    try { localStorage.setItem(this._storeKey, JSON.stringify(this._local)); } catch (e) { /* ignore */ }
  }

  _power() {
    const c = this._config;
    if (c.power_entity) {
      const s = this._hass?.states[c.power_entity];
      if (!s || ['unknown', 'unavailable'].includes(s.state)) return { state: 'unknown', assumed: false };
      const on = ['on', 'playing', 'home', 'true', 'open', 'idle', 'paused'].includes(s.state)
        || (!isNaN(parseFloat(s.state)) && parseFloat(s.state) > (c.power_threshold ?? 5));
      return { state: on ? 'on' : 'off', assumed: false };
    }
    return { state: this._local.power || 'unknown', assumed: true };
  }

  _input() {
    const c = this._config;
    if (c.input_entity) {
      const s = this._hass?.states[c.input_entity];
      return s && !['unknown', 'unavailable'].includes(s.state) ? s.state : null;
    }
    return this._local.input || null;
  }

  _muted() {
    const c = this._config;
    if (c.mute_entity) return this._hass?.states[c.mute_entity]?.state === 'on';
    return !!this._local.muted;
  }

  _volume() {
    const c = this._config;
    if (!c.volume_entity) return null;
    const s = this._hass?.states[c.volume_entity];
    if (!s) return null;
    const v = parseFloat(s.state);
    if (isNaN(v)) return null;
    const min = c.volume_min ?? s.attributes.min ?? 0;
    const max = c.volume_max ?? s.attributes.max ?? 100;
    return { value: v, min, max, unit: c.volume_unit ?? s.attributes.unit_of_measurement ?? '' };
  }

  /* ---------------- sending ---------------- */

  _toast(message) {
    this.dispatchEvent(new CustomEvent('hass-notification', { detail: { message }, bubbles: true, composed: true }));
  }

  async _fire(btn) {
    const cmd = getPath(this._config, btn.dataset.cmd);
    this.dispatchEvent(new CustomEvent('haptic', { detail: 'light', bubbles: true, composed: true }));
    btn.classList.remove('sent', 'err');
    void btn.offsetWidth;
    try {
      await sendCommand(this._hass, cmd, this._config);
      btn.classList.add('sent');
      this._afterSend(btn);
    } catch (e) {
      btn.classList.add('err');
      this._stopHold();
      this._toast(`IR remote: ${e.message || e}`);
      console.error('[ir-remote-card]', e);
    }
    setTimeout(() => btn.classList.remove('sent', 'err'), 400);
  }

  _afterSend(btn) {
    const kind = btn.dataset.kind;
    const c = this._config;
    let changed = false;
    if (kind === 'power_on') { this._local.power = 'on'; changed = true; }
    else if (kind === 'power_off') { this._local.power = 'off'; this._local.muted = false; changed = true; }
    else if (kind === 'power') {
      if (this._hold) return;
      this._local.power = this._power().state === 'on' ? 'off' : 'on';
      if (this._local.power === 'off') this._local.muted = false;
      changed = true;
    } else if (kind === 'mute' && !c.mute_entity) {
      if (this._hold) return;
      this._local.muted = !this._local.muted; changed = true;
    } else if ((kind === 'volume_up' || kind === 'volume_down') && c.unmute_on_volume && this._local.muted && !c.mute_entity) {
      this._local.muted = false; changed = true;
    } else if (kind === 'input') {
      const name = btn.dataset.name;
      if (c.input_entity) {
        const domain = c.input_entity.split('.')[0];
        const svc = {
          input_select: ['input_select', 'select_option', 'option'],
          select: ['select', 'select_option', 'option'],
          input_text: ['input_text', 'set_value', 'value'],
        }[domain];
        if (svc) this._hass.callService(svc[0], svc[1], { entity_id: c.input_entity, [svc[2]]: name }).catch((e) => console.warn(e));
      } else if (this._local.input !== name) { this._local.input = name; changed = true; }
      if (c.input_powers_on !== false && !c.power_entity && this._local.power !== 'on') { this._local.power = 'on'; changed = true; }
    }
    if (changed) {
      this._save();
      if (this._hold) this._pendingRender = true; else this._render();
    }
  }

  /* ---- hold to repeat ---- */
  _startHold(btn) {
    this._stopHold();
    const cmd = getPath(this._config, btn.dataset.cmd);
    const o = isObj(cmd) ? cmd : {};
    const delay = Number(o.repeat_delay ?? this._config.repeat_delay);
    const interval = Math.max(60, Number(o.repeat_interval ?? this._config.repeat_interval));
    this._fire(btn);
    this._hold = { btn, timer: setTimeout(() => {
      if (!this._hold) return;
      this._hold.timer = setInterval(() => this._fire(btn), interval);
    }, delay) };
    btn.classList.add('held');
  }

  _stopHold() {
    if (!this._hold) return;
    clearTimeout(this._hold.timer);
    clearInterval(this._hold.timer);
    this._hold.btn.classList.remove('held');
    this._hold = null;
    if (this._pendingRender) { this._pendingRender = false; this._render(); }
  }

  /* ---------------- rendering ---------------- */

  _btn({ path, kind, icon, label, cls = '', name, active = false, title }) {
    const cmd = getPath(this._config, path);
    if (cmd == null || cmd === '') return '';
    const repeat = holdFor(path, this._config);
    return `<button class="btn ${cls}${active ? ' active' : ''}" data-cmd="${esc(path)}" data-kind="${esc(kind || '')}"
      ${name != null ? `data-name="${esc(name)}"` : ''} ${repeat ? 'data-repeat="1"' : ''}
      title="${esc(title || label || '')}" aria-label="${esc(title || label || '')}" aria-pressed="${active}">
      ${icon ? `<ha-icon icon="${esc(icon)}"></ha-icon>` : ''}${label ? `<span>${esc(label)}</span>` : ''}</button>`;
  }

  _panel(key, body, meta = '') {
    if (!body) return '';
    const title = this._config.section_titles?.[key] || SECTION_TITLES[key];
    const collapsed = !!this._collapsed[key];
    return `<div class="panel ${key}${collapsed ? ' collapsed' : ''}">
      <div class="phead" data-toggle="${key}" role="button" tabindex="0" aria-expanded="${!collapsed}">
        <ha-icon class="picon" icon="${SECTION_ICONS[key]}"></ha-icon>
        <span class="ptitle">${esc(title)}</span>
        <span class="pmeta">${meta}</span>
        <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
      </div>
      <div class="pbody">${body}</div>
    </div>`;
  }

  _sectionPower() {
    const cm = this._config.commands;
    const has = (k) => cm[k] != null && cm[k] !== '';
    const p = this._power().state;
    const parts = [];
    if (has('power_on')) parts.push(this._btn({ path: 'commands.power_on', kind: 'power_on', icon: 'mdi:power-on', label: 'On', cls: 'on', active: p === 'on' }));
    if (has('power')) parts.push(this._btn({ path: 'commands.power', kind: 'power', icon: 'mdi:power', label: has('power_on') || has('power_off') ? 'Toggle' : (p === 'on' ? 'Turn off' : 'Turn on'), cls: 'power' }));
    if (has('power_off')) parts.push(this._btn({ path: 'commands.power_off', kind: 'power_off', icon: 'mdi:power-off', label: 'Off', cls: 'off', active: p === 'off' }));
    if (!parts.length) return '';
    return `<div class="row" style="--cols:${parts.length}">${parts.join('')}</div>`;
  }

  _sectionVolume() {
    const muted = this._muted();
    const vol = this._volume();
    const row = [
      this._btn({ path: 'commands.volume_down', kind: 'volume_down', icon: 'mdi:volume-minus', title: 'Volume down', cls: 'big' }),
      this._btn({ path: 'commands.mute', kind: 'mute', icon: muted ? 'mdi:volume-off' : 'mdi:volume-mute', label: muted ? 'Muted' : 'Mute', cls: 'mute', active: muted }),
      this._btn({ path: 'commands.volume_up', kind: 'volume_up', icon: 'mdi:volume-plus', title: 'Volume up', cls: 'big' }),
    ].filter(Boolean);
    if (!row.length && !vol) return '';
    let bar = '';
    if (vol) {
      const pct = Math.max(0, Math.min(100, ((vol.value - vol.min) / (vol.max - vol.min || 1)) * 100));
      bar = `<div class="bar"><div class="blabel"><span>Volume</span><span>${esc(vol.value)}${esc(vol.unit)}</span></div>
        <div class="track"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div></div>`;
    }
    return `${bar}${row.length ? `<div class="row vol" style="--cols:${row.length}">${row.join('')}</div>` : ''}`;
  }

  _sectionInputs() {
    const c = this._config;
    const cur = this._input();
    const items = c.inputs.map((inp, i) => this._btn({
      path: `inputs.${i}.command`, kind: 'input', name: inp.name, icon: inp.icon || 'mdi:import', label: inp.name,
      cls: 'tile', active: cur != null && cur === inp.name,
    })).join('');
    return items ? `<div class="grid" style="--cols:${c.inputs_columns}">${items}</div>` : '';
  }

  _sectionAdjust() {
    const c = this._config;
    return c.adjust.map((a, i) => {
      const down = this._btn({ path: `adjust.${i}.down`, kind: 'adjust', icon: a.down_icon || 'mdi:minus', title: `${a.name} down`, cls: 'sq' });
      const up = this._btn({ path: `adjust.${i}.up`, kind: 'adjust', icon: a.up_icon || 'mdi:plus', title: `${a.name} up`, cls: 'sq' });
      const reset = this._btn({ path: `adjust.${i}.reset`, kind: 'adjust', icon: 'mdi:restore', title: `${a.name} reset`, cls: 'reset ghost' });
      if (!down && !up && !reset) return '';
      return `<div class="adj">${down || '<span class="sqgap"></span>'}
        <div class="alabel">${a.icon ? `<ha-icon icon="${esc(a.icon)}"></ha-icon>` : ''}<span>${esc(a.name)}</span>${reset}</div>
        ${up || '<span class="sqgap"></span>'}</div>`;
    }).join('');
  }

  _sectionButtons() {
    const c = this._config;
    const items = c.buttons.map((b, i) => this._btn({
      path: `buttons.${i}.command`, kind: 'button', icon: b.icon || 'mdi:remote', label: b.name, cls: 'tile',
    })).join('');
    return items ? `<div class="grid" style="--cols:${c.buttons_columns}">${items}</div>` : '';
  }

  _render() {
    const c = this._config;
    if (!c) return;
    const power = this._power();
    const input = this._input();
    const muted = this._muted();
    const t = c.transport.type;

    const pillText = { on: 'On', off: 'Off', unknown: 'Unknown' }[power.state];
    const pillTitle = power.assumed
      ? 'Assumed state: IR is one-way, so this is the last command the card sent. Set a power entity for real state.'
      : `From ${c.power_entity}`;
    const sub = [];
    if (input) sub.push(`Input: ${esc(input)}`);
    if (muted) sub.push('Muted');
    if (!sub.length) sub.push(c.subtitle ? esc(c.subtitle) : `IR via ${({ tasmota: 'Tasmota', esphome: 'ESPHome', text: 'text entity' })[t] || 'actions'}`);

    const sections = (Array.isArray(c.sections) ? c.sections : SECTION_KEYS).map((s) => {
      switch (s) {
        case 'power': return this._panel('power', this._sectionPower());
        case 'volume': return this._panel('volume', this._sectionVolume(), muted ? '<span class="tag warn">Muted</span>' : '');
        case 'inputs': return this._panel('inputs', this._sectionInputs(), input ? `<span class="tag">${esc(input)}</span>` : '');
        case 'adjust': return this._panel('adjust', this._sectionAdjust());
        case 'buttons': return this._panel('buttons', this._sectionButtons());
        default: return '';
      }
    }).join('');

    const op = Math.max(0, Math.min(100, Number(c.background_opacity ?? 100)));
    const bg = c.card_background || 'var(--ha-card-background, var(--card-background-color, #fff))';
    const cardStyle = [
      op < 100 || c.card_background ? `background: color-mix(in srgb, ${bg} ${op}%, transparent);` : '',
      op < 100 ? 'box-shadow: none;' : '',
      c.glass_background ? 'backdrop-filter: blur(14px) saturate(1.2); -webkit-backdrop-filter: blur(14px) saturate(1.2);' : '',
    ].join('');

    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <ha-card style="${cardStyle}">
        <div class="head">
          <div class="badge ${power.state}">
            <ha-icon icon="${esc(c.icon)}"></ha-icon>
            <span class="dot ${power.state}"></span>
          </div>
          <div class="titles">
            <div class="name">${esc(c.name)}</div>
            <div class="sub">${sub.join(' · ')}</div>
          </div>
          <div class="pill ${power.state}${power.assumed ? ' assumed' : ''}" title="${esc(pillTitle)}">
            <span class="pdot"></span>${pillText}
          </div>
        </div>
        <div class="body">${sections || '<div class="empty">No sections enabled</div>'}</div>
      </ha-card>`;
    this._bind();
  }

  _bind() {
    const root = this.shadowRoot;
    root.querySelectorAll('.phead').forEach((h) => {
      const toggle = () => {
        const k = h.dataset.toggle;
        this._collapsed[k] = !this._collapsed[k];
        this._local.collapsed = { ...this._collapsed };
        this._save();
        h.parentElement.classList.toggle('collapsed', this._collapsed[k]);
        h.setAttribute('aria-expanded', String(!this._collapsed[k]));
      };
      h.addEventListener('click', toggle);
      h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
    root.querySelectorAll('button.btn').forEach((b) => {
      if (b.dataset.repeat) {
        b.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          try { b.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
          this._startHold(b);
        });
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => b.addEventListener(ev, () => this._stopHold()));
        b.addEventListener('contextmenu', (e) => e.preventDefault());
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._fire(b); } });
      } else {
        b.addEventListener('click', () => this._fire(b));
      }
    });
  }

  disconnectedCallback() {
    this._stopHold();
  }
}

const STYLE = `
:host {
  --ir-green: var(--success-color, #43a047);
  --ir-green-text: color-mix(in srgb, var(--ir-green) 60%, var(--primary-text-color, #212121));
  --ir-amber: var(--warning-color, #ffa000);
  --ir-red: var(--error-color, #db4437);
  --ir-accent: var(--primary-color, #03a9f4);
  --ir-muted: var(--secondary-text-color, #727272);
  --ir-btn: color-mix(in srgb, var(--primary-text-color, #212121) 7%, transparent);
  --ir-btn-hover: color-mix(in srgb, var(--primary-text-color, #212121) 12%, transparent);
}
ha-card { font-size: .9em; overflow: hidden; }
.head { display: flex; align-items: center; gap: 12px; padding: 14px 16px 10px; }
.badge { position: relative; flex: none; width: 42px; height: 42px; border-radius: 50%;
  display: grid; place-items: center;
  background: color-mix(in srgb, var(--ir-accent) 18%, transparent); color: var(--ir-accent); }
.badge.off, .badge.unknown { background: color-mix(in srgb, var(--ir-muted) 16%, transparent); color: var(--ir-muted); }
.badge ha-icon { --mdc-icon-size: 24px; }
.dot { position: absolute; right: 0; bottom: 0; width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid var(--ha-card-background, var(--card-background-color, #fff)); background: var(--ir-muted); }
.dot.on { background: var(--ir-green); }
.dot.unknown { background: var(--ir-amber); }
.titles { flex: 1; min-width: 0; }
.name { font-size: 1.15em; font-weight: 600; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { color: var(--ir-muted); font-size: .9em; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
  font-size: .85em; font-weight: 600; border: 1px solid transparent;
  background: color-mix(in srgb, var(--ir-muted) 16%, transparent); color: var(--ir-muted); cursor: default; }
.pill .pdot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.on { background: color-mix(in srgb, var(--ir-green) 18%, transparent); color: var(--ir-green-text); }
.pill.on .pdot { background: var(--ir-green); }
.pill.unknown { background: color-mix(in srgb, var(--ir-amber) 16%, transparent); color: var(--ir-amber); }
.pill.assumed { border-style: dashed; border-color: currentColor; }
.body { padding: 2px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.empty { color: var(--ir-muted); text-align: center; padding: 8px; font-size: .9em; }

.panel { --tint: var(--ir-accent); border-radius: 12px; background: color-mix(in srgb, var(--tint) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--tint) 16%, transparent); }
.panel.power { --tint: var(--ir-green); }
.panel.inputs { --tint: #7e57c2; }
.panel.adjust { --tint: var(--ir-amber); }
.panel.buttons { --tint: var(--ir-muted); }
.phead { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; user-select: none; outline: none; border-radius: 12px; }
.phead:focus-visible { box-shadow: inset 0 0 0 2px var(--tint); }
.picon { --mdc-icon-size: 18px; color: var(--tint); }
.ptitle { font-weight: 600; font-size: .95em; }
.pmeta { flex: 1; display: flex; justify-content: flex-end; }
.chev { --mdc-icon-size: 20px; color: var(--ir-muted); transition: transform .2s; }
.panel.collapsed .chev { transform: rotate(-90deg); }
.pbody { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.panel.collapsed .pbody { display: none; }
.tag { font-size: .8em; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  background: color-mix(in srgb, var(--tint) 18%, transparent); color: var(--primary-text-color); }
.tag.warn { background: color-mix(in srgb, var(--ir-amber) 22%, transparent); color: var(--ir-amber); }

.row, .grid { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 8px; }
.btn { font: inherit; color: var(--primary-text-color); background: var(--ir-btn); border: 1px solid transparent;
  border-radius: 12px; min-height: 44px; padding: 8px 10px; display: flex; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; user-select: none;
  transition: background .15s, transform .08s, box-shadow .2s, border-color .2s; }
.btn:hover { background: var(--ir-btn-hover); }
.btn:active, .btn.held { transform: scale(.96); }
.btn:focus-visible { outline: 2px solid var(--ir-accent); outline-offset: 1px; }
.btn ha-icon { --mdc-icon-size: 20px; flex: none; }
.btn span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.btn.big { min-height: 54px; }
.btn.big ha-icon { --mdc-icon-size: 26px; }
.btn.tile { flex-direction: column; gap: 4px; min-height: 60px; font-size: .9em; }
.btn.tile ha-icon { --mdc-icon-size: 22px; color: var(--tint); }
.btn.active { background: color-mix(in srgb, var(--tint, var(--ir-accent)) 22%, transparent);
  border-color: color-mix(in srgb, var(--tint, var(--ir-accent)) 55%, transparent); }
.btn.tile.active ha-icon { color: var(--primary-text-color); }
.btn.power ha-icon, .btn.on ha-icon { color: var(--ir-green); }
.btn.off ha-icon { color: var(--ir-red); }
.btn.on.active { --tint: var(--ir-green); }
.btn.off.active { --tint: var(--ir-red); }
.btn.mute.active { --tint: var(--ir-amber); }
.btn.mute.active ha-icon { color: var(--ir-amber); }
.btn.sent { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ir-green) 70%, transparent); }
.btn.err { box-shadow: 0 0 0 2px var(--ir-red); }
.btn.sq { min-height: 40px; width: 48px; padding: 0; flex: none; }
.sqgap { width: 48px; flex: none; }
.btn.ghost { background: transparent; color: var(--ir-muted); }
.btn.reset { min-height: 30px; width: 30px; padding: 0; flex: none; border-radius: 50%; }
.btn.reset ha-icon { --mdc-icon-size: 16px; color: var(--ir-muted); }

.adj { display: flex; align-items: center; gap: 8px; }
.alabel { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 500; }
.alabel > ha-icon { --mdc-icon-size: 18px; color: var(--tint); }

.bar { display: flex; flex-direction: column; gap: 4px; }
.blabel { display: flex; justify-content: space-between; font-size: .85em; color: var(--ir-muted); }
.blabel span:last-child { color: var(--primary-text-color); font-weight: 600; }
.track { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--tint) 15%, transparent); overflow: hidden; }
.fill { height: 100%; border-radius: 4px; background: var(--tint); transition: width .3s; }
`;

/* ======================= editor ======================= */

const MODE_LABELS = {
  none: 'Not used',
  code: 'IR code',
  raw: 'Raw IR timings',
  entity: 'Button / script / scene',
  action: 'Home Assistant action',
  sequence: 'Sequence (macro)',
};

const REPEAT_SCHEMA = (def) => ({
  type: 'expandable', name: 'repeat_opts', flatten: true, title: 'Repeat options', icon: 'mdi:repeat',
  schema: [
    { name: 'hold_repeat', label: `Repeat while held${def ? ' (default on)' : ''}`, selector: { boolean: {} } },
    { type: 'grid', name: '', schema: [
      { name: 'repeat_delay', label: 'Hold: first repeat after (blank = card default)', selector: { number: { min: 0, max: 3000, step: 10, mode: 'box', unit_of_measurement: 'ms' } } },
      { name: 'repeat_interval', label: 'Hold: repeat every (blank = card default)', selector: { number: { min: 60, max: 3000, step: 10, mode: 'box', unit_of_measurement: 'ms' } } },
      { name: 'times', label: 'Send each press', selector: { number: { min: 1, max: 20, step: 1, mode: 'box', unit_of_measurement: '×' } } },
      { name: 'gap', label: 'Gap between sends', selector: { number: { min: 0, max: 5000, step: 10, mode: 'box', unit_of_measurement: 'ms' } } },
    ] },
  ],
});

function hexStr(v) {
  return typeof v === 'number' ? `0x${v.toString(16).toUpperCase()}` : (v ?? '');
}
function pickKey(o, name) {
  return Object.keys(o).find((k) => k.toLowerCase() === name);
}

/** command -> flat form data */
function cmdToForm(cmd, type, def) {
  const d = { mode: 'none', hold_repeat: def, times: 1 };
  if (cmd == null) return d;
  if (typeof cmd === 'string') {
    if (type === 'text' && !ENTITY_CMD_RE.test(cmd)) return { ...d, mode: 'code', code: cmd };
    return { ...d, mode: 'entity', entity: cmd };
  }
  if (Array.isArray(cmd)) return { ...d, mode: 'sequence', steps: cmd };
  const { base, opts } = splitOpts(cmd);
  for (const k of REPEAT_KEYS) if (opts[k] !== undefined) d[k] = opts[k];
  if (base.sequence !== undefined) return { ...d, mode: 'sequence', steps: base.sequence };
  const act = base.action || base.service || base.perform_action;
  if (act) return { ...d, mode: 'action', action: act, action_data: base.data || base.service_data };
  if (base.entity !== undefined) return { ...d, mode: 'entity', entity: base.entity };
  if (base.raw !== undefined) {
    const { raw, ...extra } = base;
    return { ...d, mode: 'raw', raw: Array.isArray(raw) ? raw.join(', ') : String(raw), extra: isEmpty(extra) ? undefined : extra };
  }
  if (base.code !== undefined) return { ...d, mode: 'code', code: String(base.code) };
  const rest = { ...base };
  if (type === 'text') return { ...d, mode: 'code', code: '' };
  if (type === 'tasmota') {
    const out = { ...d, mode: 'code' };
    for (const [name, field] of [['protocol', 'protocol'], ['bits', 'bits'], ['data', 'ir_data']]) {
      const k = pickKey(rest, name);
      if (k) { out[field] = name === 'data' ? hexStr(rest[k]) : rest[k]; delete rest[k]; }
    }
    if (out.bits !== undefined) out.bits = toInt(out.bits);
    out.extra = isEmpty(rest) ? undefined : rest;
    return out;
  }
  const out = { ...d, mode: 'code', address: hexStr(rest.address), command: hexStr(rest.command) };
  delete rest.address; delete rest.command;
  out.extra = isEmpty(rest) ? undefined : rest;
  return out;
}

/** flat form data -> command */
function formToCmd(d, type, def) {
  const opts = {};
  if (d.hold_repeat !== undefined && !!d.hold_repeat !== !!def) opts.hold_repeat = !!d.hold_repeat;
  for (const k of ['repeat_delay', 'repeat_interval', 'gap']) {
    if (d[k] !== undefined && d[k] !== null && d[k] !== '' && !isNaN(Number(d[k]))) opts[k] = Number(d[k]);
  }
  if (Number(d.times) > 1) opts.times = Number(d.times);
  const extra = isObj(d.extra) ? d.extra : {};
  switch (d.mode) {
    case 'none': return undefined;
    case 'entity':
      return isEmpty(opts) ? (d.entity || '') : { entity: d.entity || '', ...opts };
    case 'action': {
      const out = { action: d.action || '' };
      if (!isEmpty(d.action_data)) out.data = d.action_data;
      return { ...out, ...opts };
    }
    case 'raw':
      return { raw: d.raw || '', ...extra, ...opts };
    case 'sequence':
      return { sequence: Array.isArray(d.steps) ? d.steps : [], ...opts };
    case 'code':
    default:
      if (type === 'text') return { code: d.code ?? '', ...opts };
      if (type === 'tasmota') {
        const out = {};
        if (!isEmpty(d.protocol)) out.protocol = d.protocol;
        if (!isEmpty(d.bits)) out.bits = toInt(d.bits);
        out.data = d.ir_data || '';
        return { ...out, ...extra, ...opts };
      }
      return { address: d.address || '', command: d.command || '', ...extra, ...opts };
  }
}

function cmdSchema(mode, type, transport, def) {
  const modes = ['none'];
  if (type !== 'none') modes.push('code');
  if (type === 'esphome' || type === 'tasmota') modes.push('raw');
  modes.push('entity', 'action', 'sequence');
  const s = [{
    name: 'mode', label: 'Send as',
    selector: { select: { mode: 'dropdown', options: modes.map((m) => ({ value: m, label: MODE_LABELS[m] })) } },
  }];
  const tdef = transport.data || {};
  switch (mode) {
    case 'code':
      if (type === 'text') {
        s.push({ name: 'code', label: 'Code to send (the text set on the IR entity)', selector: { text: {} } });
        break;
      }
      if (type === 'tasmota') {
        s.push({ type: 'grid', name: '', schema: [
          { name: 'protocol', label: `Protocol${tdef.protocol ? ` (default ${tdef.protocol})` : ''}`, selector: { text: {} } },
          { name: 'bits', label: `Bits${tdef.bits ? ` (default ${tdef.bits})` : ''}`, selector: { number: { min: 1, max: 128, mode: 'box' } } },
        ] });
        s.push({ name: 'ir_data', label: 'Data (e.g. 0x5EA1F807)', selector: { text: {} } });
      } else {
        s.push({ type: 'grid', name: '', schema: [
          { name: 'address', label: 'Address (e.g. 0x7A85)', selector: { text: {} } },
          { name: 'command', label: 'Command (e.g. 0x1A)', selector: { text: {} } },
        ] });
      }
      s.push({ name: 'extra', label: 'Extra fields (YAML, optional)', selector: { object: {} } });
      break;
    case 'raw':
      s.push({
        name: 'raw',
        label: type === 'tasmota' ? 'Raw IRSend payload (e.g. 0,9000,4500,560,…)' : 'Raw timings in µs, + on / − off (e.g. 9000, -4500, 560, -560)',
        selector: { text: { multiline: true } },
      });
      if (type === 'esphome') s.push({ name: 'extra', label: 'Extra fields (YAML, optional, e.g. carrier_frequency: 38000)', selector: { object: {} } });
      break;
    case 'entity':
      s.push({ name: 'entity', label: 'Entity', selector: { entity: { filter: { domain: ['button', 'input_button', 'script', 'scene'] } } } });
      break;
    case 'action':
      s.push({ name: 'action', label: 'Action (domain.action, e.g. esphome.ir_blaster_send_pronto)', selector: { text: {} } });
      s.push({ name: 'action_data', label: 'Data (YAML)', selector: { object: {} } });
      break;
    case 'sequence':
      s.push({ name: 'steps', label: 'Steps (YAML list of commands; {delay: ms} to wait)', selector: { object: {} } });
      break;
    default:
      return s;
  }
  s.push(REPEAT_SCHEMA(def));
  return s;
}

function describeCmd(cmd, type) {
  if (cmd == null) return 'not used';
  const d = cmdToForm(cmd, type, false);
  switch (d.mode) {
    case 'entity': return d.entity || 'no entity';
    case 'action': return d.action || 'action';
    case 'raw': return 'raw';
    case 'sequence': return `sequence (${(Array.isArray(d.steps) ? d.steps.length : 0)} steps)`;
    case 'code': if (type === 'text') return d.code || 'no code';
      return type === 'tasmota' ? (d.ir_data || 'no code') : (d.address || d.command ? `${d.address || '?'} / ${d.command || '?'}` : 'no code');
    default: return '';
  }
}

class IrRemoteCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._open = new Set(['general']);
    this._order = null;
    this._ready = false;
  }

  set hass(h) {
    this._hass = h;
    this.shadowRoot.querySelectorAll('ha-form').forEach((f) => { f.hass = h; });
  }

  setConfig(config) {
    const s = JSON.stringify(config || {});
    if (s === this._lastEmitted) return;
    this._config = JSON.parse(s);
    const enabled = Array.isArray(this._config.sections) ? this._config.sections.filter((k) => SECTION_KEYS.includes(k)) : [...SECTION_KEYS];
    const prev = this._order || SECTION_KEYS;
    this._order = [...enabled, ...prev.filter((k) => !enabled.includes(k)), ...SECTION_KEYS.filter((k) => !enabled.includes(k) && !prev.includes(k))];
    if (this._ready) this._render();
  }

  connectedCallback() {
    if (this._ready) return;
    this._load().then(() => { this._ready = true; if (this._config) this._render(); });
  }

  async _load() {
    if (customElements.get('ha-form')) return;
    try {
      const helpers = await window.loadCardHelpers?.();
      const c = await helpers?.createCardElement({ type: 'entities', entities: [] });
      await c?.constructor?.getConfigElement?.();
    } catch (e) { /* ignore */ }
    await Promise.race([customElements.whenDefined('ha-form'), sleep(4000)]);
  }

  get _type() { return (this._config.transport?.type || 'esphome').toLowerCase(); }

  _emit() {
    const c = this._config;
    for (const k of ['commands', 'transport']) if (isObj(c[k]) && !Object.keys(c[k]).length && k !== 'commands') delete c[k];
    this._lastEmitted = JSON.stringify(c);
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: JSON.parse(this._lastEmitted) }, bubbles: true, composed: true }));
  }

  /* ---- templating helpers ---- */

  _mount(schema, data, onChange) {
    const id = this._mounts.length;
    this._mounts.push({ schema, data, onChange });
    return `<div class="mount" data-mount="${id}"></div>`;
  }

  _block(id, title, icon, body, extra = '') {
    const open = this._open.has(id);
    return `<div class="blk${open ? ' open' : ''}">
      <div class="bhead" data-open="${esc(id)}"><ha-icon icon="${icon}"></ha-icon><span class="btitle">${esc(title)}</span>${extra}
        <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></div>
      ${open ? `<div class="bbody">${body}</div>` : ''}</div>`;
  }

  _cmd(path, label) {
    const type = this._type;
    const def = holdDefault(path, this._config);
    const cmd = getPath(this._config, path);
    const data = cmdToForm(cmd, type, def);
    const transport = this._config.transport || {};
    return `<div class="cmd" data-path="${esc(path)}">
      <div class="chead"><span class="clabel">${esc(label)}</span><span class="cdesc">${esc(describeCmd(cmd, type))}</span>
        <button class="test" data-test="${esc(path)}" title="Send this command now"><ha-icon icon="mdi:send"></ha-icon>Test</button></div>
      <div class="cstatus" data-status="${esc(path)}"></div>
      ${this._mount(cmdSchema(data.mode, type, transport, def), data, (v, form) => {
        const prev = form.data?.mode;
        let nv = v;
        if (v.mode !== prev) {
          // fresh fields for the new mode, keep repeat options
          nv = { mode: v.mode };
          for (const k of REPEAT_KEYS) if (v[k] !== undefined) nv[k] = v[k];
          if (v.mode === 'entity') nv.entity = '';
          if (v.mode === 'sequence') nv.steps = [];
          form.schema = cmdSchema(v.mode, type, transport, def);
        }
        form.data = nv;
        setPath(this._config, path, formToCmd(nv, type, def));
        const desc = this.shadowRoot.querySelector(`.cmd[data-path="${CSS.escape(path)}"] .cdesc`);
        if (desc) desc.textContent = describeCmd(getPath(this._config, path), type);
        this._emit();
      })}
    </div>`;
  }

  _listBlock(sec, key, label, newItem, bodyFn) {
    const items = this._config[key] || [];
    const rows = items.map((it, i) => {
      const id = `${key}.${i}`;
      const open = this._open.has(id);
      return `<div class="item${open ? ' open' : ''}">
        <div class="ihead" data-open="${id}">
          <ha-icon icon="${esc(it?.icon || (key === 'adjust' ? 'mdi:tune' : key === 'inputs' ? 'mdi:import' : 'mdi:remote'))}"></ha-icon>
          <span class="iname">${esc(it?.name || `(${label} ${i + 1})`)}</span>
          <button class="ib" data-move="${key}:${i}:-1" title="Move up" ${i === 0 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="ib" data-move="${key}:${i}:1" title="Move down" ${i === items.length - 1 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-down"></ha-icon></button>
          <button class="ib del" data-del="${key}:${i}" title="Remove"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
          <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
        </div>
        ${open ? `<div class="ibody">${bodyFn(it, i)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="list">${rows || `<div class="none">No ${label.toLowerCase()}s yet</div>`}</div>
      <button class="add" data-add="${key}"><ha-icon icon="mdi:plus"></ha-icon>Add ${label.toLowerCase()}</button>`;
  }

  _itemForm(key, i, extraFields = []) {
    const it = this._config[key][i] || {};
    const data = { name: it.name, icon: it.icon };
    for (const f of extraFields) data[f.name] = it[f.name];
    const schema = [{ type: 'grid', name: '', schema: [
      { name: 'name', label: 'Name', selector: { text: {} } },
      { name: 'icon', label: 'Icon', selector: { icon: {} } },
    ] }, ...extraFields];
    return this._mount(schema, data, (v, form) => {
      form.data = v;
      const item = this._config[key][i];
      for (const k of ['name', 'icon', ...extraFields.map((f) => f.name)]) {
        if (isEmpty(v[k])) delete item[k]; else item[k] = v[k];
      }
      const head = this.shadowRoot.querySelector(`.ihead[data-open="${key}.${i}"]`);
      if (head) {
        head.querySelector('.iname').textContent = v.name || `(${i + 1})`;
        if (v.icon) head.querySelector('ha-icon').setAttribute('icon', v.icon);
      }
      this._emit();
    });
  }

  _sectionBody(sec) {
    const c = this._config;
    const cols = (key) => this._mount(
      [{ name: key, label: 'Columns', selector: { number: { min: 1, max: 6, step: 1, mode: 'slider' } } }],
      { [key]: c[key] ?? OPTION_DEFAULTS[key] },
      (v, form) => { form.data = v; this._setOpt(key, v[key]); this._emit(); },
    );
    switch (sec) {
      case 'power':
        return `<p class="hint">Use a single toggle code, discrete on/off codes, or both.</p>
          ${this._cmd('commands.power', 'Power toggle')}${this._cmd('commands.power_on', 'Power on')}${this._cmd('commands.power_off', 'Power off')}`;
      case 'volume':
        return `${this._cmd('commands.volume_up', 'Volume up')}${this._cmd('commands.volume_down', 'Volume down')}${this._cmd('commands.mute', 'Mute')}`;
      case 'inputs':
        return cols('inputs_columns') + this._listBlock(sec, 'inputs', 'Input', null,
          (it, i) => this._itemForm('inputs', i) + this._cmd(`inputs.${i}.command`, 'Command'));
      case 'adjust':
        return this._listBlock(sec, 'adjust', 'Control', null,
          (it, i) => this._itemForm('adjust', i)
            + this._cmd(`adjust.${i}.down`, 'Down (−)') + this._cmd(`adjust.${i}.up`, 'Up (+)') + this._cmd(`adjust.${i}.reset`, 'Reset (optional)'));
      case 'buttons':
        return cols('buttons_columns') + this._listBlock(sec, 'buttons', 'Button', null,
          (it, i) => this._itemForm('buttons', i) + this._cmd(`buttons.${i}.command`, 'Command'));
      default: return '';
    }
  }

  _setOpt(k, v) {
    if (isEmpty(v) || v === OPTION_DEFAULTS[k]) delete this._config[k];
    else this._config[k] = v;
  }

  _render() {
    const c = this._config;
    const type = this._type;
    const t = c.transport || {};
    this._mounts = [];

    // ---- general ----
    const genSchema = [
      { type: 'grid', name: '', schema: [
        { name: 'name', label: 'Name', selector: { text: {} } },
        { name: 'icon', label: 'Icon', selector: { icon: {} } },
      ] },
      { name: 'subtitle', label: 'Subtitle (shown when no input is known)', selector: { text: {} } },
      { name: 'type', label: 'IR blaster', selector: { select: { mode: 'dropdown', options: [
        { value: 'esphome', label: 'ESPHome' }, { value: 'tasmota', label: 'Tasmota (MQTT)' }, { value: 'text', label: 'Text entity (text.set_value)' }, { value: 'none', label: 'None: buttons, scripts and actions only' },
      ] } } },
    ];
    if (type === 'esphome') {
      genSchema.push({ name: 'service', label: 'ESPHome send action (e.g. esphome.ir_blaster_send_nec)', selector: { text: {} } });
      genSchema.push({ name: 'raw_service', label: 'ESPHome raw send action (optional, e.g. esphome.ir_blaster_send_raw)', selector: { text: {} } });
    } else if (type === 'text') {
      genSchema.push({ name: 'entity', label: 'Text entity that sends the IR code', selector: { entity: { filter: { domain: ['text', 'input_text'] } } } });
      genSchema.push({ type: 'grid', name: '', schema: [
        { name: 'prefix', label: 'Prefix added to every code (optional)', selector: { text: {} } },
        { name: 'suffix', label: 'Suffix added to every code (optional)', selector: { text: {} } },
      ] });
      genSchema.push({ type: 'grid', name: '', schema: [
        { name: 'reset_value', label: 'Then set it back to (optional)', selector: { text: {} } },
        { name: 'reset_delay', label: 'after (default 100)', selector: { number: { min: 0, max: 5000, step: 10, mode: 'box', unit_of_measurement: 'ms' } } },
      ] });
    } else if (type === 'tasmota') {
      genSchema.push({ name: 'topic', label: 'Tasmota device topic (sends to cmnd/<topic>/IRSend)', selector: { text: {} } });
    }
    if (type === 'esphome' || type === 'tasmota') {
      genSchema.push({ name: 'data', label: type === 'tasmota' ? 'Fields added to every code (YAML, e.g. protocol: NEC, bits: 32)' : 'Fields added to every code (YAML, optional)', selector: { object: {} } });
    }
    const genData = { name: c.name ?? 'Stereo Amplifier', icon: c.icon ?? 'mdi:amplifier', subtitle: c.subtitle, type, service: t.service, raw_service: t.raw_service, topic: t.topic, data: t.data, entity: t.entity, prefix: t.prefix, suffix: t.suffix, reset_value: t.reset_value, reset_delay: t.reset_delay };
    const general = this._mount(genSchema, genData, (v, form) => {
      form.data = v;
      for (const k of ['name', 'icon', 'subtitle']) { if (isEmpty(v[k])) delete c[k]; else c[k] = v[k]; }
      const nt = { ...(c.transport || {}) };
      for (const k of ['type', 'service', 'raw_service', 'topic', 'data', 'entity', 'prefix', 'suffix', 'reset_value', 'reset_delay']) { if (isEmpty(v[k])) delete nt[k]; else nt[k] = v[k]; }
      c.transport = nt;
      this._emit();
      if ((nt.type || 'esphome') !== type) this._render();
    });

    // ---- state entities ----
    const stateSchema = [
      { name: 'power_entity', label: 'Power state (on/off entity or power sensor)', selector: { entity: {} } },
      { name: 'power_threshold', label: 'Power sensor: on above', selector: { number: { min: 0, max: 500, step: 0.5, mode: 'box', unit_of_measurement: 'W' } } },
      { name: 'input_entity', label: 'Current input (input_select / select / input_text)', selector: { entity: { filter: { domain: ['input_select', 'select', 'input_text'] } } } },
      { name: 'volume_entity', label: 'Volume level (shows a bar)', selector: { entity: { filter: { domain: ['number', 'input_number', 'sensor'] } } } },
      { name: 'mute_entity', label: 'Mute state', selector: { entity: {} } },
    ];
    const stateData = {};
    for (const f of stateSchema) stateData[f.name] = c[f.name] ?? OPTION_DEFAULTS[f.name];
    const state = `<p class="hint">IR is one-way. Without these, the card remembers the last command it sent (per browser).</p>`
      + this._mount(stateSchema, stateData, (v, form) => {
        form.data = v;
        for (const f of stateSchema) this._setOpt(f.name, v[f.name]);
        this._emit();
      });

    // ---- sections ----
    const enabled = Array.isArray(c.sections) ? c.sections : SECTION_KEYS;
    const secRows = this._order.map((k, i) => `<div class="secrow${enabled.includes(k) ? '' : ' off'}">
        <input type="checkbox" data-sec="${k}" ${enabled.includes(k) ? 'checked' : ''} aria-label="Show ${SECTION_TITLES[k]}">
        <ha-icon icon="${SECTION_ICONS[k]}"></ha-icon>
        <input class="stitle" data-title="${k}" placeholder="${SECTION_TITLES[k]}" value="${esc(c.section_titles?.[k] || '')}" aria-label="Title for ${SECTION_TITLES[k]}">
        <label class="coll" title="Start collapsed"><input type="checkbox" data-coll="${k}" ${(c.collapsed || []).includes(k) ? 'checked' : ''}>collapsed</label>
        <button class="ib" data-smove="${i}:-1" ${i === 0 ? 'disabled' : ''} title="Move up"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
        <button class="ib" data-smove="${i}:1" ${i === this._order.length - 1 ? 'disabled' : ''} title="Move down"><ha-icon icon="mdi:arrow-down"></ha-icon></button>
      </div>`).join('');
    const sections = `<p class="hint">Tick to show, use the arrows to reorder. Titles are optional.</p><div class="secs">${secRows}</div>`;

    // ---- per section content ----
    const content = this._order.filter((k) => enabled.includes(k)).map((k) =>
      this._block(`sec:${k}`, c.section_titles?.[k] || SECTION_TITLES[k], SECTION_ICONS[k], this._sectionBody(k))).join('');

    // ---- options ----
    const optSchema = [
      { type: 'grid', name: '', schema: [
        { name: 'repeat_delay', label: 'Hold: first repeat after', selector: { number: { min: 0, max: 3000, step: 10, mode: 'box', unit_of_measurement: 'ms' } } },
        { name: 'repeat_interval', label: 'Hold: repeat every', selector: { number: { min: 60, max: 3000, step: 10, mode: 'box', unit_of_measurement: 'ms' } } },
        { name: 'macro_delay', label: 'Pause between sequence steps', selector: { number: { min: 0, max: 5000, step: 10, mode: 'box', unit_of_measurement: 'ms' } } },
      ] },
      { name: 'unmute_on_volume', label: 'Volume change clears mute', selector: { boolean: {} } },
      { name: 'input_powers_on', label: 'Choosing an input marks the amp as on', selector: { boolean: {} } },
      { name: 'background_opacity', label: 'Background opacity', selector: { number: { min: 0, max: 100, step: 5, mode: 'slider', unit_of_measurement: '%' } } },
      { name: 'glass_background', label: 'Glass (blurred) background', selector: { boolean: {} } },
      { name: 'card_background', label: 'Card background colour (CSS, optional)', selector: { text: {} } },
      { name: 'debug', label: 'Log every send to the browser console', selector: { boolean: {} } },
    ];
    const optKeys = ['repeat_delay', 'repeat_interval', 'macro_delay', 'unmute_on_volume', 'input_powers_on', 'background_opacity', 'glass_background', 'card_background', 'debug'];
    const optData = {};
    for (const k of optKeys) optData[k] = c[k] ?? OPTION_DEFAULTS[k];
    const options = this._mount(optSchema, optData, (v, form) => {
      form.data = v;
      for (const k of optKeys) this._setOpt(k, v[k]);
      this._emit();
    });

    this.shadowRoot.innerHTML = `<style>${EDITOR_STYLE}</style>
      <div class="ed">
        ${this._block('general', 'General & IR blaster', 'mdi:remote', general)}
        ${this._block('state', 'State entities', 'mdi:state-machine', state)}
        ${this._block('sections', 'Sections', 'mdi:view-sequential', sections)}
        ${content}
        ${this._block('options', 'Options', 'mdi:cog', options)}
        <div class="ver">IR Remote Card v${CARD_VERSION}</div>
      </div>`;

    // mount the forms
    this.shadowRoot.querySelectorAll('.mount').forEach((el) => {
      const m = this._mounts[Number(el.dataset.mount)];
      const form = document.createElement('ha-form');
      form.hass = this._hass;
      form.data = m.data;
      form.schema = m.schema;
      form.computeLabel = (s) => s.label ?? s.name;
      form.addEventListener('value-changed', (e) => {
        e.stopPropagation();
        m.onChange(e.detail.value, form);
      });
      el.replaceWith(form);
    });
    this._bind();
  }

  _bind() {
    const root = this.shadowRoot;
    const c = this._config;
    root.querySelectorAll('[data-open]').forEach((h) => h.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const id = h.dataset.open;
      if (this._open.has(id)) this._open.delete(id); else this._open.add(id);
      this._render();
    }));
    const setSections = () => {
      const on = new Set(Array.isArray(c.sections) ? c.sections : SECTION_KEYS);
      const list = this._order.filter((k) => on.has(k));
      if (list.length === SECTION_KEYS.length && list.every((k, i) => k === SECTION_KEYS[i])) delete c.sections;
      else c.sections = list;
    };
    root.querySelectorAll('input[data-sec]').forEach((cb) => cb.addEventListener('change', () => {
      const on = new Set(Array.isArray(c.sections) ? c.sections : SECTION_KEYS);
      if (cb.checked) on.add(cb.dataset.sec); else on.delete(cb.dataset.sec);
      c.sections = this._order.filter((k) => on.has(k));
      setSections();
      this._emit();
      this._render();
    }));
    root.querySelectorAll('input[data-coll]').forEach((cb) => cb.addEventListener('change', () => {
      const set = new Set(c.collapsed || []);
      if (cb.checked) set.add(cb.dataset.coll); else set.delete(cb.dataset.coll);
      if (set.size) c.collapsed = this._order.filter((k) => set.has(k)); else delete c.collapsed;
      this._emit();
    }));
    root.querySelectorAll('input[data-title]').forEach((inp) => inp.addEventListener('input', () => {
      const titles = { ...(c.section_titles || {}) };
      if (inp.value.trim()) titles[inp.dataset.title] = inp.value; else delete titles[inp.dataset.title];
      if (Object.keys(titles).length) c.section_titles = titles; else delete c.section_titles;
      this._emit();
    }));
    root.querySelectorAll('button[data-smove]').forEach((b) => b.addEventListener('click', () => {
      const [i, d] = b.dataset.smove.split(':').map(Number);
      const j = i + d;
      if (j < 0 || j >= this._order.length) return;
      [this._order[i], this._order[j]] = [this._order[j], this._order[i]];
      setSections();
      this._emit();
      this._render();
    }));
    root.querySelectorAll('button[data-move]').forEach((b) => b.addEventListener('click', () => {
      const [key, si, sd] = b.dataset.move.split(':');
      const i = Number(si); const j = i + Number(sd);
      const arr = c[key];
      if (!arr || j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      const oi = this._open.has(`${key}.${i}`); const oj = this._open.has(`${key}.${j}`);
      this._open.delete(`${key}.${i}`); this._open.delete(`${key}.${j}`);
      if (oi) this._open.add(`${key}.${j}`);
      if (oj) this._open.add(`${key}.${i}`);
      this._emit();
      this._render();
    }));
    root.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', () => {
      const [key, si] = b.dataset.del.split(':');
      const i = Number(si);
      c[key].splice(i, 1);
      if (!c[key].length) delete c[key];
      // shift open state
      const open = new Set();
      for (const id of this._open) {
        const m = id.match(new RegExp(`^${key}\\.(\\d+)$`));
        if (!m) open.add(id);
        else if (Number(m[1]) < i) open.add(id);
        else if (Number(m[1]) > i) open.add(`${key}.${Number(m[1]) - 1}`);
      }
      this._open = open;
      this._emit();
      this._render();
    }));
    root.querySelectorAll('button[data-add]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.add;
      const type = this._type;
      const blank = () => (type === 'tasmota' ? { data: '' } : type === 'esphome' ? { address: '', command: '' } : type === 'text' ? { code: '' } : '');
      const arr = c[key] || (c[key] = []);
      const n = arr.length + 1;
      if (key === 'inputs') arr.push({ name: `Input ${n}`, icon: 'mdi:import', command: blank() });
      else if (key === 'adjust') arr.push({ name: n === 1 ? 'Bass' : n === 2 ? 'Treble' : `Control ${n}`, icon: n === 2 ? 'mdi:music-clef-treble' : 'mdi:speaker', down: blank(), up: blank() });
      else arr.push({ name: `Button ${n}`, icon: 'mdi:remote', command: blank() });
      this._open.add(`${key}.${arr.length - 1}`);
      this._emit();
      this._render();
    }));
    root.querySelectorAll('button[data-test]').forEach((b) => b.addEventListener('click', async () => {
      const path = b.dataset.test;
      const st = root.querySelector(`.cstatus[data-status="${CSS.escape(path)}"]`);
      try {
        await sendCommand(this._hass, getPath(c, path), { ...OPTION_DEFAULTS, ...c, transport: { type: 'esphome', ...(c.transport || {}) } });
        if (st) { st.className = 'cstatus ok'; st.textContent = 'Sent'; }
      } catch (e) {
        if (st) { st.className = 'cstatus bad'; st.textContent = e.message || String(e); }
      }
      setTimeout(() => { if (st) { st.className = 'cstatus'; st.textContent = ''; } }, 4000);
    }));
  }
}

const EDITOR_STYLE = `
:host { display: block; }
.ed { display: flex; flex-direction: column; gap: 10px; }
.blk { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 12px; overflow: hidden; }
.bhead, .ihead { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; user-select: none; }
.bhead { background: color-mix(in srgb, var(--primary-color, #03a9f4) 6%, transparent); }
.bhead > ha-icon:first-child { color: var(--primary-color, #03a9f4); --mdc-icon-size: 20px; }
.btitle { flex: 1; font-weight: 600; }
.chev { color: var(--secondary-text-color); transition: transform .2s; --mdc-icon-size: 20px; }
.blk:not(.open) > .bhead .chev, .item:not(.open) > .ihead .chev { transform: rotate(-90deg); }
.bbody { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.hint { margin: 0; font-size: .85em; color: var(--secondary-text-color); }
.secs { display: flex; flex-direction: column; gap: 6px; }
.secrow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 10px;
  background: color-mix(in srgb, var(--primary-text-color, #212121) 4%, transparent); }
.secrow.off { opacity: .55; }
.secrow > ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); }
.secrow input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--primary-color, #03a9f4); margin: 0; }
.stitle { flex: 1; min-width: 0; font: inherit; color: var(--primary-text-color); background: transparent;
  border: 1px solid var(--divider-color, #ccc); border-radius: 8px; padding: 6px 8px; }
.stitle:focus { outline: 2px solid var(--primary-color, #03a9f4); border-color: transparent; }
.coll { display: flex; align-items: center; gap: 4px; font-size: .8em; color: var(--secondary-text-color); white-space: nowrap; }
.coll input { width: 14px !important; height: 14px !important; }
.ib { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; border: none; background: transparent;
  color: var(--secondary-text-color); cursor: pointer; padding: 0; flex: none; }
.ib:hover:not([disabled]) { background: color-mix(in srgb, var(--primary-text-color, #212121) 8%, transparent); color: var(--primary-text-color); }
.ib[disabled] { opacity: .3; cursor: default; }
.ib ha-icon { --mdc-icon-size: 18px; }
.ib.del:hover { color: var(--error-color, #db4437) !important; }
.list { display: flex; flex-direction: column; gap: 6px; }
.item { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 10px; }
.ihead { padding: 4px 6px 4px 10px; }
.ihead > ha-icon:first-child { --mdc-icon-size: 20px; color: var(--secondary-text-color); }
.iname { flex: 1; font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ibody { padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 10px; }
.none { font-size: .85em; color: var(--secondary-text-color); padding: 4px 2px; }
.add { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; font: inherit; font-weight: 500;
  color: var(--primary-color, #03a9f4); background: transparent; border: 1px dashed currentColor; border-radius: 10px; padding: 6px 12px; cursor: pointer; }
.add ha-icon { --mdc-icon-size: 18px; }
.cmd { border-left: 3px solid color-mix(in srgb, var(--primary-color, #03a9f4) 45%, transparent);
  padding: 4px 0 4px 10px; display: flex; flex-direction: column; gap: 6px; }
.chead { display: flex; align-items: center; gap: 8px; }
.clabel { font-weight: 600; }
.cdesc { flex: 1; font-size: .8em; color: var(--secondary-text-color); font-family: var(--code-font-family, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.test { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: .85em; font-weight: 500;
  color: var(--primary-color, #03a9f4); background: color-mix(in srgb, var(--primary-color, #03a9f4) 10%, transparent);
  border: none; border-radius: 999px; padding: 4px 10px; cursor: pointer; }
.test ha-icon { --mdc-icon-size: 16px; }
.cstatus { font-size: .8em; }
.cstatus:empty { display: none; }
.cstatus.ok { color: var(--success-color, #43a047); }
.cstatus.bad { color: var(--error-color, #db4437); }
.ver { text-align: right; font-size: .75em; color: var(--secondary-text-color); }
`;

customElements.define('ir-remote-card', IrRemoteCard);
customElements.define('ir-remote-card-editor', IrRemoteCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'ir-remote-card',
  name: 'IR Remote Card',
  description: 'Remote for IR devices (stereo amp) via an ESPHome or Tasmota IR blaster',
  preview: true,
  documentationURL: 'https://github.com/sargeantpepper/IRRemoteCustomCard',
});

console.info(`%c IR-REMOTE-CARD %c v${CARD_VERSION} `,
  'color:#fff;background:#7e57c2;font-weight:700;border-radius:3px 0 0 3px',
  'color:#7e57c2;background:#fff;font-weight:700;border-radius:0 3px 3px 0');
