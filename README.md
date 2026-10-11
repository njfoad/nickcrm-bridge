# Avaya Element SDK Bridge (NickCRM)

A headless, bidirectional iframe bridge built with TypeScript and Vite that connects a custom React CRM to the Avaya CCaaS "Element" SDK. 

This bridge acts as a middleware translation layer. It intercepts native window events from the parent CRM and translates them into Avaya SDK commands, while simultaneously listening to Avaya interaction events and pushing normalized screen pop payloads back up to the CRM.

## Features
* **Click-to-Dial:** Dynamically resolves agent queues and executes native Avaya outbound dials.
* **Real-time Screen Pops:** Subscribes to Avaya interaction events (`alerting`, `updated`) to push custom metadata to the CRM before the agent even answers the call.
* **Just-In-Time (JIT) Routing:** Bypasses Avaya boot-up race conditions by fetching agent Queue IDs on-demand during the first outbound dial.
* **Hydration Delay:** Implements an intelligent 500ms delay during the `alerting` phase to allow the Avaya backend cache to hydrate custom interaction variables.
* **Greedy Listener Bypass:** Uses the `postMessage` capture phase to intercept CRM commands before Avaya's aggressive internal listeners can swallow them.

## Architecture

The bridge is designed to be hosted in a subfolder of the main CRM (e.g., `njfoadCRM/bridge`) and loaded as a hidden or side-panel iframe. 

```text
[ React CRM (Parent) ]  <--- postMessage --->  [ NickCRM Bridge (Iframe) ]  <--- ElementAPI --->  [ Avaya CCaaS ]
```

## Setup & Installation

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Build for Production:**
   ```bash
   npm run build
   ```
   *Note: `vite.config.ts` is configured with `base: './'` to ensure relative pathing works perfectly when hosted inside a CRM subdirectory.*

3. **Deploy:**
   Copy the contents of the `dist` folder to your CRM's hosting directory (e.g., `/var/www/html/njfoadCRM/bridge`).

## Communication Protocol

Communication between the host CRM and the Bridge is handled entirely via `window.postMessage`.

### 1. Click-to-Dial (CRM -> Bridge)
To trigger an outbound call, the parent CRM must send a `voice:dialout` message to the bridge iframe.

**Example Payload:**
```javascript
iframe.contentWindow.postMessage({
  channel: 'infinity-crm-bridge',
  type: 'voice:dialout',
  payload: { 
    phoneNumber: '+19176858541',
    queueId: '003' // Optional. Bridge will auto-fetch the agent's default queue if omitted.
  }
}, '*'); 
// Note: Target origin '*' or the exact domain where the bridge is hosted.
```

### 2. Screen Pop (Bridge -> CRM)
When an interaction arrives (or is updated), the bridge extracts the custom CRM data (specifically looking for `custom.crm.nickCRM`) and posts it up to the parent window.

**Example Payload:**
```javascript
window.addEventListener('message', (event) => {
  if (event.data?.type === 'SCREEN_POP') {
    const { phoneNumber, myData, rawPayload } = event.data;
    console.log('Incoming call from:', phoneNumber);
    console.log('Custom Avaya Metadata:', myData);
  }
});
```

## Technical Notes & CCaaS Quirks Handled

* **Avaya Event Swallowing:** The Avaya SDK aggressively intercepts window messages. To prevent the CRM's `voice:dialout` messages from being destroyed, the bridge's downstream listener uses `{ capture: true }`.
* **The "Null" Alerting Event:** When a call enters the `alerting` state, the Avaya event fires *before* the backend has fully hydrated the interaction object with custom IVR variables. The bridge introduces a non-blocking `500ms` delay on `alerting` events to guarantee `api.getInteraction()` returns the full payload.
* **Strict Case Sensitivity:** Interaction data must be accessed exactly at `custom.crm.nickCRM`. CCaaS environments are strictly case-sensitive.
* **Duplicate Event Prevention:** Avaya fires multiple status updates per interaction phase. The bridge uses a `dataStash` map with `stableStringify` hashing to ensure the CRM only receives one Screen Pop per unique dataset.

## Development
To modify the bridge logic, edit `src/bridge.ts`. The application boots from `src/main.ts`. UI boilerplate (CSS/HTML components) has been intentionally removed as this is a headless integration.