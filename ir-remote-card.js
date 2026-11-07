/*
 * IR Remote Card for Home Assistant
 * A remote for IR-controlled devices (built for a stereo amplifier), sending
 * commands through an ESPHome or Tasmota IR blaster. Styled to match the
 * TrueNAS / Proxmox VE cards: badge header, status pill, tinted collapsible panels.
 */
const CARD_VERSION = '1.0.0';

const DEFAULT_SECTIONS = ['power', 'volume', 'inputs', 'adjust', 'buttons'];
const SECTION_TITLES = {
  power: 'Power',
  volume: 'Volume',
  inputs: 'Inputs',
  adjust: 'Tone',
  buttons: 'Extras',
};
const SECTION_ICONS = {
  power: 'mdi:power',
  volume: 'mdi:volume-high',
  inputs: 'mdi:import',
  adjust: 'mdi:tune-vertical',
  buttons: 'mdi:dots-grid',
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HEX_RE = /^0x[0-9a-f]+$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class IrRemoteCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hold = null;
    this._sig = '';
    this._collapsed = {};
    this._local = {};
  }

  static getStubConfig() {
    return {
      name: 'Stereo Amplifier',
      icon: 'mdi:amplifier',
      transport: { type: 'esphome', service: 'esphome.ir_blaster_send_nec' },
      commands: {
        power: { address: '0x00', command: '0x00' },
        volume_up: { address: '0x00', command: '0x00' },
        volume_down: { address: '0x00', command: '0x00' },
        mute: { address: '0x00', command: '0x00' },
      },
      inputs: [
        { name: 'CD', icon: 'mdi:disc', command: { address: '0x00', command: '0x00' } },
        { name: 'Tuner', icon: 'mdi:radio', command: { address: '0x00', command: '0x00' } },
        { name: 'Aux', icon: 'mdi:audio-input-rca', command: { address: '0x00', command: '0x00' } },
      ],
    };
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');
    const t = config.transport || {};
    const type = (t.type || 'esphome').toLowerCase();
    if (!['esphome', 'tasmota', 'none'].includes(type)) {
      throw new Error(`transport.type must be esphome, tasmota or none (got "${t.type}")`);
    }
    if (type === 'tasmota' && !t.topic && !t.full_topic) {
      throw new Error('transport.topic is required for Tasmota (the device topic, e.g. tasmota_ir)');
    }
    this._config = {
      name: 'Stereo Amplifier',
      icon: 'mdi:amplifier',
      sections: DEFAULT_SECTIONS,
      inputs_columns: 3,
      buttons_columns: 3,
      repeat_delay: 400,
      repeat_interval: 180,
      unmute_on_volume: true,
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
    const collapsed = config.collapsed || [];
    this._collapsed = {};
    for (const s of collapsed) this._collapsed[s] = true;
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
      return s ? `${s.state}|${s.attributes.min}|${s.attributes.max}|${s.attributes.options}` : 'x';
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

  _lookup(path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this._config);
  }

  _resolve(cmd) {
    if (cmd == null) return null;
    if (typeof cmd === 'string') {
      const domain = cmd.split('.')[0];
      if (domain === 'button' || domain === 'input_button') return { domain, service: 'press', data: { entity_id: cmd } };
      if (domain === 'script' || domain === 'scene') return { domain, service: 'turn_on', data: { entity_id: cmd } };
      throw new Error(`Don't know how to send "${cmd}"`);
    }
    if (typeof cmd !== 'object') throw new Error('Invalid command');
    const act = cmd.action || cmd.service || cmd.perform_action;
    if (act) {
      const [domain, service] = act.split('.');
      const data = { ...(cmd.data || cmd.service_data || {}) };
      if (cmd.target) Object.assign(data, cmd.target);
      return { domain, service, data };
    }
    if (cmd.entity) return this._resolve(cmd.entity);

    const t = this._config.transport;
    if (t.type === 'esphome') {
      if (!t.service) throw new Error('transport.service is not set (e.g. esphome.ir_blaster_send_nec)');
      const [domain, service] = t.service.split('.');
      const data = {};
      for (const [k, v] of Object.entries({ ...(t.data || {}), ...cmd })) {
        if (k === 'service_override') continue;
        data[k] = typeof v === 'string' && HEX_RE.test(v) ? parseInt(v, 16) : v;
      }
      if (cmd.service_override) {
        const [d2, s2] = cmd.service_override.split('.');
        delete data.service_override;
        return { domain: d2, service: s2, data };
      }
      return { domain, service, data };
    }
    if (t.type === 'tasmota') {
      const topic = t.full_topic || `cmnd/${t.topic}/IRSend`;
      let payload;
      if (cmd.raw) payload = String(cmd.raw);
      else {
        const p = {};
        const map = { protocol: 'Protocol', bits: 'Bits', data: 'Data', data_lsb: 'DataLSB', repeat: 'Repeat' };
        for (const [k, v] of Object.entries({ ...(t.data || {}), ...cmd })) {
          const key = map[k.toLowerCase()] || k;
          if (key === 'Data' && typeof v === 'number') p[key] = `0x${v.toString(16).toUpperCase()}`;
          else p[key] = v;
        }
        payload = JSON.stringify(p);
      }
      return { domain: 'mqtt', service: 'publish', data: { topic, payload } };
    }
    throw new Error('No transport configured for this command');
  }

  async _send(cmd) {
    if (Array.isArray(cmd)) {
      for (const step of cmd) {
        if (step && typeof step === 'object' && !Array.isArray(step) && Object.keys(step).length === 1 && 'delay' in step) {
          await sleep(Number(step.delay) || 0);
        } else {
          await this._send(step);
          if (this._config.macro_delay) await sleep(this._config.macro_delay);
        }
      }
      return;
    }
    const call = this._resolve(cmd);
    if (!call) return;
    if (this._config.debug) console.info('[ir-remote-card]', call.domain, call.service, call.data);
    await this._hass.callService(call.domain, call.service, call.data);
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent('hass-notification', { detail: { message }, bubbles: true, composed: true }));
  }

  _haptic() {
    this.dispatchEvent(new CustomEvent('haptic', { detail: 'light', bubbles: true, composed: true }));
  }

  async _fire(btn) {
    const path = btn.dataset.cmd;
    const cmd = this._lookup(path);
    this._haptic();
    btn.classList.remove('sent', 'err');
    void btn.offsetWidth;
    try {
      await this._send(cmd);
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
      const p = this._power().state;
      this._local.power = p === 'on' ? 'off' : 'on';
      if (this._local.power === 'off') this._local.muted = false;
      changed = true;
    } else if (kind === 'mute' && !c.mute_entity) { this._local.muted = !this._local.muted; changed = true; }
    else if ((kind === 'volume_up' || kind === 'volume_down') && c.unmute_on_volume && this._local.muted && !c.mute_entity) {
      this._local.muted = false; changed = true;
    } else if (kind === 'input') {
      const name = btn.dataset.name;
      if (c.input_entity) {
        const domain = c.input_entity.split('.')[0];
        const svc = { input_select: ['input_select', 'select_option', 'option'], select: ['select', 'select_option', 'option'], input_text: ['input_text', 'set_value', 'value'] }[domain];
        if (svc) this._hass.callService(svc[0], svc[1], { entity_id: c.input_entity, [svc[2]]: name }).catch((e) => console.warn(e));
      } else { this._local.input = name; changed = true; }
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
    this._fire(btn);
    this._hold = { btn, timer: setTimeout(() => {
      if (!this._hold) return;
      this._hold.timer = setInterval(() => this._fire(btn), this._config.repeat_interval);
    }, this._config.repeat_delay) };
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

  _btn({ path, kind, icon, label, cls = '', repeat = false, name, active = false, title }) {
    const cmd = this._lookup(path);
    if (cmd == null) return '';
    return `<button class="btn ${cls}${active ? ' active' : ''}" data-cmd="${esc(path)}" data-kind="${esc(kind || '')}"
      ${name != null ? `data-name="${esc(name)}"` : ''} ${repeat ? 'data-repeat="1"' : ''}
      title="${esc(title || label || '')}" aria-label="${esc(title || label || '')}" aria-pressed="${active}">
      ${icon ? `<ha-icon icon="${esc(icon)}"></ha-icon>` : ''}${label ? `<span>${esc(label)}</span>` : ''}</button>`;
  }

  _panel(key, body, meta = '') {
    if (!body) return '';
    const c = this._config;
    const title = c.section_titles?.[key] ?? SECTION_TITLES[key];
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
    const p = this._power().state;
    const parts = [];
    if (cm.power_on != null) parts.push(this._btn({ path: 'commands.power_on', kind: 'power_on', icon: 'mdi:power-on', label: 'On', cls: 'on', active: p === 'on' }));
    if (cm.power != null) parts.push(this._btn({ path: 'commands.power', kind: 'power', icon: 'mdi:power', label: cm.power_on != null || cm.power_off != null ? 'Toggle' : (p === 'on' ? 'Turn off' : 'Turn on'), cls: 'power' }));
    if (cm.power_off != null) parts.push(this._btn({ path: 'commands.power_off', kind: 'power_off', icon: 'mdi:power-off', label: 'Off', cls: 'off', active: p === 'off' }));
    if (!parts.length) return '';
    return `<div class="row" style="--cols:${parts.length}">${parts.join('')}</div>`;
  }

  _sectionVolume() {
    const cm = this._config.commands;
    const muted = this._muted();
    const vol = this._volume();
    const row = [
      this._btn({ path: 'commands.volume_down', kind: 'volume_down', icon: 'mdi:volume-minus', title: 'Volume down', cls: 'big', repeat: true }),
      this._btn({ path: 'commands.mute', kind: 'mute', icon: muted ? 'mdi:volume-off' : 'mdi:volume-mute', label: muted ? 'Muted' : 'Mute', cls: 'mute', active: muted }),
      this._btn({ path: 'commands.volume_up', kind: 'volume_up', icon: 'mdi:volume-plus', title: 'Volume up', cls: 'big', repeat: true }),
    ].filter(Boolean);
    if (!row.length && !vol) return '';
    let bar = '';
    if (vol) {
      const pct = Math.max(0, Math.min(100, ((vol.value - vol.min) / (vol.max - vol.min || 1)) * 100));
      bar = `<div class="bar"><div class="blabel"><span>Volume</span><span>${esc(vol.value)}${esc(vol.unit)}</span></div>
        <div class="track"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div></div>`;
    }
    const extra = cm.volume_hint ? `<div class="hint">${esc(cm.volume_hint)}</div>` : '';
    return `${bar}${row.length ? `<div class="row vol" style="--cols:${row.length}">${row.join('')}</div>` : ''}${extra}`;
  }

  _sectionInputs() {
    const c = this._config;
    if (!c.inputs.length) return '';
    const cur = this._input();
    const items = c.inputs.map((inp, i) => this._btn({
      path: `inputs.${i}.command`, kind: 'input', name: inp.name, icon: inp.icon || 'mdi:import', label: inp.name,
      cls: 'tile', active: cur != null && cur === inp.name,
    })).join('');
    return `<div class="grid" style="--cols:${c.inputs_columns}">${items}</div>`;
  }

  _sectionAdjust() {
    const c = this._config;
    if (!c.adjust.length) return '';
    return c.adjust.map((a, i) => `<div class="adj">
        ${this._btn({ path: `adjust.${i}.down`, kind: 'adjust', icon: a.down_icon || 'mdi:minus', title: `${a.name} down`, cls: 'sq', repeat: a.repeat !== false })}
        <div class="alabel">${a.icon ? `<ha-icon icon="${esc(a.icon)}"></ha-icon>` : ''}<span>${esc(a.name)}</span>
          ${a.reset != null ? this._btn({ path: `adjust.${i}.reset`, kind: 'adjust', icon: 'mdi:restore', title: `${a.name} reset`, cls: 'reset ghost' }) : ''}</div>
        ${this._btn({ path: `adjust.${i}.up`, kind: 'adjust', icon: a.up_icon || 'mdi:plus', title: `${a.name} up`, cls: 'sq', repeat: a.repeat !== false })}
      </div>`).join('');
  }

  _sectionButtons() {
    const c = this._config;
    if (!c.buttons.length) return '';
    const items = c.buttons.map((b, i) => this._btn({
      path: `buttons.${i}.command`, kind: 'button', icon: b.icon || 'mdi:remote', label: b.name, cls: 'tile', repeat: !!b.hold_repeat,
    })).join('');
    return `<div class="grid" style="--cols:${c.buttons_columns}">${items}</div>`;
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
      ? 'Assumed state: IR is one-way, so this is the last command the card sent. Set power_entity for real state.'
      : `From ${c.power_entity}`;
    const sub = [];
    if (input) sub.push(`Input: ${esc(input)}`);
    if (muted) sub.push('Muted');
    if (!sub.length) sub.push(c.subtitle ? esc(c.subtitle) : `IR via ${t === 'tasmota' ? 'Tasmota' : t === 'esphome' ? 'ESPHome' : 'actions'}`);

    const sections = (c.sections || DEFAULT_SECTIONS).map((s) => {
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
        <div class="body">${sections}</div>
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
.btn.power ha-icon { color: var(--ir-green); }
.btn.on ha-icon { color: var(--ir-green); }
.btn.off ha-icon { color: var(--ir-red); }
.btn.on.active { --tint: var(--ir-green); }
.btn.off.active { --tint: var(--ir-red); }
.btn.mute.active { --tint: var(--ir-amber); }
.btn.mute.active ha-icon { color: var(--ir-amber); }
.btn.sent { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ir-green) 70%, transparent); }
.btn.err { box-shadow: 0 0 0 2px var(--ir-red); }
.btn.sq { min-height: 40px; width: 48px; padding: 0; flex: none; }
.btn.ghost { background: transparent; color: var(--ir-muted); }
.btn.reset { min-height: 30px; width: 30px; padding: 0; flex: none; border-radius: 50%; }
.btn.reset ha-icon { --mdc-icon-size: 16px; }

.adj { display: flex; align-items: center; gap: 8px; }
.alabel { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 500; }
.alabel ha-icon { --mdc-icon-size: 18px; color: var(--tint); }

.bar { display: flex; flex-direction: column; gap: 4px; }
.blabel { display: flex; justify-content: space-between; font-size: .85em; color: var(--ir-muted); }
.blabel span:last-child { color: var(--primary-text-color); font-weight: 600; }
.track { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--tint) 15%, transparent); overflow: hidden; }
.fill { height: 100%; border-radius: 4px; background: var(--tint); transition: width .3s; }
.hint { font-size: .8em; color: var(--ir-muted); text-align: center; }
`;

customElements.define('ir-remote-card', IrRemoteCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'ir-remote-card',
  name: 'IR Remote Card',
  description: 'Remote for IR devices (stereo amp) via an ESPHome or Tasmota IR blaster',
  preview: false,
  documentationURL: 'https://github.com/sargeantpepper/IRRemoteCustomCard',
});

console.info(`%c IR-REMOTE-CARD %c v${CARD_VERSION} `,
  'color:#fff;background:#7e57c2;font-weight:700;border-radius:3px 0 0 3px',
  'color:#7e57c2;background:#fff;font-weight:700;border-radius:0 3px 3px 0');
