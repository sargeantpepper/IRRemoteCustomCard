# IR Remote Card

A Home Assistant Lovelace card for IR-controlled kit, built for a stereo amplifier. It sends commands through an **ESPHome** or **Tasmota** IR blaster, or through any HA action, script or button entity. It is styled to match the TrueNAS / Proxmox VE cards: a badge header with a status dot, a status pill and tinted, collapsible panels.

- **Power** (on / off / toggle), **Volume** (hold to repeat), **Mute**, **Inputs**, **Tone** (bass/treble style −/+ rows) and **Extras**
- Remembers the current input, power and mute state (IR is one-way, so these are *assumed* unless you give it real entities)
- Optional real state: a smart-plug power sensor for on/off, an `input_select` for the input, a number/sensor for a volume bar
- Macros: a list of commands with optional delays (e.g. power on → wait → select TV)
- Background options shared with the TrueNAS card: `background_opacity`, `glass_background`, `card_background`

![IR Remote Card](images/preview.png)

*(Preview from the test harness: icons are placeholders.)*

## Install

**HACS:** HACS → ⋮ → Custom repositories → `https://github.com/sargeantpepper/IRRemoteCustomCard`, type *Dashboard*, then install **IR Remote Card**.

**Manual:**


1. Copy `ir-remote-card.js` to `/config/www/ir-remote-card.js`.
2. **Settings → Dashboards → ⋮ → Resources → Add**: `/local/ir-remote-card.js?v=1.0.0`, type *JavaScript module*.
3. Bump `?v=` after every update. HA caches hard.

## ESPHome setup

Add a transmitter, plus a receiver if you need to learn your amp's codes, and expose an action that takes the code:

```yaml
esphome:
  name: ir-blaster

remote_transmitter:
  pin: GPIO4
  carrier_duty_percent: 50%

remote_receiver:            # optional: for learning codes
  pin: { number: GPIO14, inverted: true, mode: INPUT_PULLUP }
  dump: all

api:
  actions:
    - action: send_nec
      variables:
        address: int
        command: int
      then:
        - remote_transmitter.transmit_nec:
            address: !lambda 'return address;'
            command: !lambda 'return command;'
```

HA then has `esphome.ir_blaster_send_nec` (node name with `-` → `_`, then `_` + action name).

**Learning codes:** open the device logs in ESPHome, point the amp's remote at the receiver and press each key. You'll see lines like `Received NEC: address=0x7A85, command=0x1A`. Those two numbers go into the card.

Other protocols (RC5, Sony, Samsung, raw…) work the same way. Add another action, e.g. `send_rc5` with `transmit_rc5`, and either set it as the transport `service` or override it per command with `service_override: esphome.ir_blaster_send_rc5`.

## Tasmota setup

With Tasmota-IR flashed and the MQTT integration in HA, the card publishes to `cmnd/<topic>/IRSend`. Learn codes from the Tasmota console: each received key shows `{"IrReceived":{"Protocol":"NEC","Bits":32,"Data":"0x5EA1F807"}}`.

## Example: ESPHome

```yaml
type: custom:ir-remote-card
name: Stereo Amplifier
icon: mdi:amplifier
transport:
  type: esphome
  service: esphome.ir_blaster_send_nec
# Optional real state (otherwise assumed from the last command sent):
# power_entity: sensor.amp_plug_power    # >5 W = on (power_threshold)
# input_entity: input_select.amp_input   # options must match the input names
# volume_entity: number.amp_volume       # shows a volume bar
commands:
  power: { address: 0x7A85, command: 0x1F }
  # power_on / power_off if your amp has discrete codes
  volume_up: { address: 0x7A85, command: 0x1A }
  volume_down: { address: 0x7A85, command: 0x1B }
  mute: { address: 0x7A85, command: 0x1C }
inputs:
  - { name: CD, icon: mdi:disc, command: { address: 0x7A85, command: 0x15 } }
  - { name: Tuner, icon: mdi:radio, command: { address: 0x7A85, command: 0x16 } }
  - { name: Phono, icon: mdi:record-player, command: { address: 0x7A85, command: 0x14 } }
  - { name: Aux, icon: mdi:audio-input-rca, command: { address: 0x7A85, command: 0x13 } }
  - name: TV                                  # macro: power on, wait, then select input
    icon: mdi:television
    command:
      - { address: 0x7A85, command: 0x1D }
      - delay: 1500
      - { address: 0x7A85, command: 0x12 }
adjust:
  - { name: Bass, icon: mdi:speaker, down: { address: 0x7A85, command: 0x30 }, up: { address: 0x7A85, command: 0x31 } }
  - { name: Treble, icon: mdi:music-clef-treble, down: { address: 0x7A85, command: 0x32 }, up: { address: 0x7A85, command: 0x33 } }
buttons:
  - { name: Loudness, icon: mdi:equalizer, command: { address: 0x7A85, command: 0x40 } }
  - { name: Direct, icon: mdi:arrow-right-bold, command: { address: 0x7A85, command: 0x41 } }
collapsed: [adjust]
```

## Example: Tasmota

```yaml
type: custom:ir-remote-card
name: Stereo Amplifier
transport:
  type: tasmota
  topic: tasmota_ir           # device topic; or full_topic: cmnd/tasmota_ir/IRSend
  data: { protocol: NEC, bits: 32 }   # defaults merged into every command
commands:
  power: { data: "0x5EA1F807" }
  volume_up: { data: "0x5EA158A7" }
  volume_down: { data: "0x5EA1D827" }
  mute: { data: "0x5EA138C7" }
inputs:
  - { name: CD, icon: mdi:disc, command: { data: "0x5EA1A857" } }
  - { name: Aux, command: { raw: "0,9000,4500,560,…" } }   # raw IRSend payload
```

## Commands

Anywhere a command is expected you can use:

| Form | Sends |
|---|---|
| `{ address: 0x.., command: 0x.. }` (ESPHome) | `transport.service` with those fields; `"0x.."` strings become numbers |
| `{ protocol, bits, data }` / `{ raw }` (Tasmota) | `mqtt.publish` to `cmnd/<topic>/IRSend` |
| `button.amp_dimmer` / `input_button.x` | `button.press` |
| `script.amp_on` / `scene.x` | `turn_on` |
| `{ action: domain.service, data: {…} }` | any HA action |
| a list, with `{ delay: ms }` steps | a macro, run in order |

## Options

| Option | Default | |
|---|---|---|
| `name`, `icon`, `subtitle` | Stereo Amplifier, `mdi:amplifier` | subtitle shows when no input or mute is known |
| `transport.type` | `esphome` | `esphome`, `tasmota` or `none` (action/entity commands only) |
| `transport.service` | – | ESPHome action, e.g. `esphome.ir_blaster_send_nec` |
| `transport.topic` / `full_topic` | – | Tasmota |
| `transport.data` | – | fields merged into every command |
| `power_entity` | – | `on`/`off`, or a numeric power sensor (`power_threshold`, default 5 W) |
| `input_entity` | – | `input_select`, `select` or `input_text`; the card sets it when you press an input |
| `volume_entity` | – | number/sensor; `volume_min`/`volume_max`/`volume_unit` override its attributes |
| `mute_entity` | – | on/off entity for real mute state |
| `sections` | `[power, volume, inputs, adjust, buttons]` | order and which to show |
| `section_titles` | – | e.g. `{ adjust: Tone & Balance }` |
| `collapsed` | `[]` | sections that start collapsed (the user's choice is then remembered) |
| `inputs_columns`, `buttons_columns` | 3 | |
| `repeat_delay`, `repeat_interval` | 400, 180 ms | hold-to-repeat timing for volume and tone |
| `unmute_on_volume` | true | assumed mute clears when volume changes |
| `input_powers_on` | true | selecting an input marks the amp as on (assumed state) |
| `macro_delay` | 0 | extra ms between macro steps |
| `background_opacity` | 100 | 0–100 |
| `glass_background` | false | backdrop blur |
| `card_background` | – | CSS colour |
| `storage_key` | name | where the assumed state is kept in the browser |
| `debug` | false | log every call to the console |

Assumed state lives in each browser's local storage, so two phones can disagree. Set `power_entity`, `input_entity` and so on if you want one shared truth. A smart plug with power monitoring is the easy way to get real on/off.

## License

MIT, see [LICENSE](LICENSE).
