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

    async initialize() {
        console.log('[NickCRM Bridge] Initializing Element SDK...');

        const iframe = document.getElementById('avaya-agent-iframe') as HTMLIFrameElement;
        if (!iframe || !iframe.contentWindow) {
            console.error('[NickCRM Bridge] Iframe not found or not ready.');
            return;
        }

        try {
            this.api = new ElementAPI({
                requestTarget: iframe.contentWindow,
                elementId: 'nickCRM-bridge', // A unique ID for your custom bridge
                debug: true, // Helpful while you are building it
                timeout: 10000
            });

            console.log('[NickCRM Bridge] API connected to iframe successfully.');

            this.setupUpstreamListener();
            this.setupDownstreamListener();

        } catch (error) {
            console.error('[NickCRM Bridge] Failed to initialize Avaya SDK:', error);
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
            console.log(`[NickCRM Bridge] No NickCRM attachment found for interaction ${id}: `, JSON.stringify( fullInt, null, 2));
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
            this.handleInteractionEvent( 'updated',payload);
        });
        this.api.onInteractionStatusChanged(async ( payload : any) => {
            this.handleInteractionEvent('status changed', payload);
        });
    }

    // --- DOWNSTREAM: React CRM -> Avaya ---
    private setupDownstreamListener(): void {
        window.addEventListener('message', async (event) => { // <-- Note the 'async' here
            const data = event.data;
            if (!data || typeof data !== 'object') return;

            if (data.type === 'voice:dialout') {
                const numberToDial = data.phoneNumber || data.payload?.phoneNumber;

                if (numberToDial) {
                    console.log(`[NickCRM Bridge] Executing dial command to ${numberToDial}`);

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