import { ElementAPI } from '@avaya/infinity-elements-api';

const NICK_CRM_ATTACHMENT_KEY = 'nickCRM';

function stableStringify(obj: any): string {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(item => stableStringify(item)).join(',')}]`;
    const sortedKeys = Object.keys(obj).sort();
    const keyValPairs = sortedKeys.map(key => `"${key}":${stableStringify(obj[key])}`);
    return `{${keyValPairs.join(',')}}`;
}

export class NickCRMBridge {
    private api: any;
    private defaultQueueId: string = '';
    private dataStash = new Map<string, string>();
    
    // Popup state management
    private popupWindow: Window | null = null;
    private checkClosedInterval: any = null;

    async initialize() {
        console.log('[NickCRM Bridge] Booting up...');
        // 1. Set up the permanent listener for React CRM commands
        this.setupDownstreamListener();
        
        // 2. Do the initial Avaya SDK bind to the embedded iframe
        this.bindElementAPI();
    }

    // Extracted binding logic so we can re-run it when the window target changes
    private bindElementAPI(targetWindow?: Window) {
        console.log('[NickCRM Bridge] Binding Element SDK...');
        let target = targetWindow;

        // If no target is passed, default to the embedded iframe
        if (!target) {
            const iframe = document.getElementById('avaya-agent-iframe') as HTMLIFrameElement;
            if (!iframe || !iframe.contentWindow) {
                console.error('[NickCRM Bridge] Iframe not found or not ready.');
                return;
            }
            target = iframe.contentWindow;
        }

        try {
            this.api = new ElementAPI({
                requestTarget: target,
                elementId: 'nickCRM-bridge',
                debug: true,
                timeout: 10000
            });

            console.log('[NickCRM Bridge] API connected to target window successfully.');
            // Re-attach upstream listeners to the new API instance
            this.setupUpstreamListener();

        } catch (error) {
            console.error('[NickCRM Bridge] Failed to initialize Avaya SDK:', error);
        }
    }

    // --- POPUP MANAGEMENT ---
    private popOut() {
        if (this.popupWindow && !this.popupWindow.closed) return;

        const iframe = document.getElementById('avaya-agent-iframe') as HTMLIFrameElement;
        if (!iframe) return;

        console.log('[NickCRM Bridge] Executing Pop Out...');
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';

        // Open the new window
        this.popupWindow = window.open(iframe.src, 'AvayaAgentPopup', 'width=450,height=800');

        if (this.popupWindow) {
            // Re-bind the Avaya SDK to the new popup window!
            this.bindElementAPI(this.popupWindow);

            // Poll to detect if the user clicks the native "X" to close the window
            this.checkClosedInterval = setInterval(() => {
                if (this.popupWindow && this.popupWindow.closed) {
                    clearInterval(this.checkClosedInterval);
                    this.popIn();
                }
            }, 500);
        }
    }

    private popIn() {
        console.log('[NickCRM Bridge] Executing Pop In...');
        if (this.checkClosedInterval) clearInterval(this.checkClosedInterval);
        
        if (this.popupWindow && !this.popupWindow.closed) {
            this.popupWindow.close();
        }
        this.popupWindow = null;

        const iframe = document.getElementById('avaya-agent-iframe') as HTMLIFrameElement;
        if (iframe && iframe.contentWindow) {
            iframe.style.opacity = '1';
            iframe.style.pointerEvents = 'auto';
            // Re-bind the Avaya SDK back to the embedded iframe
            this.bindElementAPI(iframe.contentWindow);
        }
    }

    private async handleInteractionEvent(eventType: string, payload: any): Promise<void> {
        if (!payload || (!payload.id && !payload.interactionId)) return;
        const id = payload.id || payload.interactionId;
        console.log(`[NickCRM Bridge] Interaction ${eventType}: ${id} ${payload.status}`);

        if (payload.status === 'alerting' || payload.status === 'pending') {
            console.log(`[NickCRM Bridge] Alerting phase detected. Waiting 500ms for backend sync...`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        let custom: any = {};
        let fullInt;
        try {
            fullInt = await this.api.getInteraction(id);
            custom = fullInt?.custom;
        } catch (error) {
            console.error('[NickCRM Bridge] Error fetching full interaction:', error);
            return;
        }

        const currentPhase = (fullInt?.status || payload.state || '').toLowerCase();

        if (currentPhase === 'wrapup' || currentPhase === 'completed') {
            console.log(`[NickCRM Bridge] Interaction ${id} is in phase '${currentPhase}', clearing data stash.`);
            this.dataStash.delete(id);
            return;
        }

        const attachment = custom?.crm?.[NICK_CRM_ATTACHMENT_KEY];
        if (!attachment) {
            console.log(`[NickCRM Bridge] No NickCRM attachment found for interaction ${id}.`);
            return;
        }

        const dataHash = stableStringify(attachment);
        if (this.dataStash.get(id) === dataHash) {
            console.log(`[NickCRM Bridge] Data for interaction ${id} has not changed.`);
            return;
        }
        this.dataStash.set(id, dataHash);

        const ids = Array.isArray(attachment) ? attachment : [attachment];
        const phoneNumber = ids[0]?.ID ? String(ids[0].ID) : null;

        window.parent.postMessage({
            type: 'SCREEN_POP',
            phoneNumber: phoneNumber,
            myData: attachment,
            rawPayload: payload
        }, '*');
    }

    // --- UPSTREAM: Avaya -> React CRM ---
    private setupUpstreamListener(): void {
        this.api.onInteractionUpdated(async ({ payload }: any) => {
            this.handleInteractionEvent('updated', payload);
        });
        this.api.onInteractionStatusChanged(async (payload: any) => {
            this.handleInteractionEvent('status changed', payload);
        });
    }

    // --- DOWNSTREAM: React CRM -> Avaya ---
    private setupDownstreamListener(): void {
        window.addEventListener('message', async (event) => {
            const data = event.data;
            if (!data || typeof data !== 'object') return;

            // 1. Handle Pop-Out / Pop-In UI Commands
            if (data.type === 'ui:pop-out') {
                this.popOut();
                return;
            }
            if (data.type === 'ui:pop-in') {
                this.popIn();
                return;
            }

            // 2. Handle Voice Dialout
            if (data.type === 'voice:dialout') {
                const numberToDial = data.phoneNumber || data.payload?.phoneNumber;

                if (numberToDial) {
                    console.log(`[NickCRM Bridge] Executing dial command to ${numberToDial}`);

                    // Fetch Queue ID JIT if missing
                    if (!this.defaultQueueId && typeof this.api.getUserInfo === 'function') {
                        try {
                            console.log('[NickCRM Bridge] Fetching user info to get queue ID...');
                            const userInfo = await this.api.getUserInfo();
                            if (userInfo.queues && userInfo.queues.length > 0) {
                                this.defaultQueueId = userInfo.queues[0].queueId;
                                console.log(`[NickCRM Bridge] Set default dial queue to: ${this.defaultQueueId}`);
                            }
                        } catch (error) {
                            console.error('[NickCRM Bridge] Failed to fetch user info for dialout:', error);
                        }
                    }

                    if (typeof this.api.createVoiceInteraction === 'function') {
                        try {
                            await this.api.createVoiceInteraction({ phoneNumber: numberToDial, queueId: this.defaultQueueId });
                            console.log(`[NickCRM Bridge] Successfully initiated dialout to ${numberToDial}`);
                        } catch (error) {
                            console.error('[NickCRM Bridge] Failed to create voice interaction:', error);
                        }
                    } else {
                        console.error('[NickCRM Bridge] Error: this.api.createVoiceInteraction is undefined.');
                    }
                }
            }
        }, true);
    }
}

// Boot it up
const bridge = new NickCRMBridge();
bridge.initialize();