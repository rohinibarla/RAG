/** Rail Announcements Generator. By Roy Curtis, MIT license, 2018 */

type VoxKey = string | number;

/** Synthesizes speech by dynamically loading and piecing together voice files */
class VoxEngine
{
    /** List of impulse responses that come with RAG */
    public static readonly REVERBS : Dictionary<string> = {
        ''                     : 'None',
        'ir.stalbans.wav'      : 'The Lady Chapel, St Albans Cathedral',
        'ir.middle_tunnel.wav' : 'Innocent Railway Tunnel, Edinburgh',
        'ir.grange-centre.wav' : 'Grange stone circle, County Limerick'
    };

    /** The core audio context that handles audio effects and playback */
    private readonly audioContext : AudioContext;
    /** Audio node that amplifies or attenuates voice */
    private readonly gainNode     : GainNode;
    /** Audio node that applies the tannoy filter */
    private readonly filterNode   : BiquadFilterNode;
    /**
     * Cache of impulse responses reverb nodes, for reverb. This used to be a dictionary
     * of AudioBuffers, but ConvolverNodes cannot have their buffers changed.
     */
    private readonly impulses : Dictionary<ConvolverNode> = {};
    /** Relative path to fetch impulse response and chime files from */
    private readonly dataPath : string;

    /** Event handler for when speech has audibly begun */
    public  onspeak?         : () => void;
    /** Event handler for when speech has ended */
    public  onstop?          : () => void;
    /** Whether this engine is currently running and speaking */
    public  isSpeaking       : boolean      = false;
    /** Whether this engine has begun speaking for a current speech */
    private begunSpeaking    : boolean      = false;
    /** Reference number for the current pump timer */
    private pumpTimer        : number       = 0;
    /** Tracks the audio context's wall-clock time to schedule next clip */
    private nextBegin        : number       = 0;
    /** References to currently pending requests, as a FIFO queue */
    private pendingReqs      : VoxRequest[] = [];
    /** References to currently scheduled audio buffers */
    private scheduledBuffers : AudioBufferSourceNode[] = [];
    /** List of vox IDs currently being run through */
    private currentIds?      : VoxKey[];
    /** Speech settings currently being used */
    private currentSettings? : SpeechSettings;
    /** Reverb node currently being used */
    private currentReverb?   : ConvolverNode;

    public constructor(dataPath: string = 'data/vox')
    {
        // Setup the core audio context

        // @ts-ignore - Defining these in Window interface does not work
        let audioContext  = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new audioContext();

        if (!this.audioContext)
            throw new Error('Could not get audio context');

        // Setup nodes

        this.dataPath   = dataPath;
        this.gainNode   = this.audioContext.createGain();
        this.filterNode = this.audioContext.createBiquadFilter();

        this.filterNode.type      = 'highpass';
        this.filterNode.Q.value   = 0.4;

        this.gainNode.connect(this.filterNode);
        // Rest of nodes get connected when speak is called
    }

    /**
     * Begins loading and speaking a set of vox files. Stops any speech.
     *
     * @param ids List of vox ids to load as files, in speaking order
     * @param settings Voice settings to use
     */
    public speak(ids: VoxKey[], settings: SpeechSettings) : void
    {
        console.debug('VOX SPEAK:', ids, settings);

        // Set state

        if (this.isSpeaking)
            this.stop();

        this.isSpeaking      = true;
        this.begunSpeaking   = false;
        this.currentIds      = ids;
        this.currentSettings = settings;

        // Set reverb

        if ( Strings.isNullOrEmpty(settings.voxReverb) )
            this.setReverb();
        else
        {
            let file   = settings.voxReverb!;
            let reverb = this.impulses[file];

            if (!reverb)
            {
                // Make sure reverb is off first, else clips will queue in the audio
                // buffer and all suddenly play at the same time, when reverb loads.
                this.setReverb();

                fetch(`${this.dataPath}/${file}`)
                    .then( res => res.arrayBuffer() )
                    .then( buf => Sounds.decode(this.audioContext, buf) )
                    .then( imp => this.createReverb(file, imp) );
            }
            else
                this.setReverb(reverb);
        }

        // Set volume

        let volume = either(settings.volume, 1);

        // Remaps the 1.1...1.9 range to 2...10
        if (volume > 1)
            volume = (volume * 10) - 9;

        this.gainNode.gain.value = volume;

        // Set chime, at forced playback rate of 1

        if ( !Strings.isNullOrEmpty(settings.voxChime) )
        {
            let path      = `${this.dataPath}/${settings.voxChime!}`;
            let req       = new VoxRequest(path, 0, this.audioContext);
            req.forceRate = 1;

            this.pendingReqs.push(req);
            ids.unshift(1.0);
        }

        // Begin the pump loop. On iOS, the context may have to be resumed first

        if (this.audioContext.state === 'suspended')
            this.audioContext.resume().then( () => this.pump() );
        else
            this.pump();
    }

    /** Stops playing any currently spoken speech and resets state */
    public stop() : void
    {
        // Already stopped? Do not continue
        if (!this.isSpeaking)
            return;

        // Stop pumping
        clearTimeout(this.pumpTimer);

        this.isSpeaking = false;

        // Cancel all pending requests
        this.pendingReqs.forEach( r => r.cancel() );

        // Kill and dereference any currently playing file
        this.scheduledBuffers.forEach(node =>
        {
            node.stop();
            node.disconnect();
        });

        this.nextBegin        = 0;
        this.currentIds       = undefined;
        this.currentSettings  = undefined;
        this.pendingReqs      = [];
        this.scheduledBuffers = [];

        console.debug('VOX STOPPED');

        if (this.onstop)
            this.onstop();
    }

    /**
     * Pumps the speech queue, by keeping up to 10 fetch requests for voice files going,
     * and then feeding their data (in enforced order) to the audio chain, one at a time.
     */
    private pump() : void
    {
        // If the engine has stopped, do not proceed.
        if (!this.isSpeaking || !this.currentIds || !this.currentSettings)
            return;

        // First, schedule fulfilled requests into the audio buffer, in FIFO order
        this.schedule();

        // Then, fill any free pending slots with new requests
        let nextDelay = 0;

        while (this.currentIds[0] && this.pendingReqs.length < 10)
        {
            let key = this.currentIds.shift()!;

            // If this key is a number, it's an amount of silence, so add it as the
            // playback delay for the next playable request (if any).
            if (typeof key === 'number')
            {
                nextDelay += key;
                continue;
            }

            let path = `${this.currentSettings.voxPath}/${key}.mp3`;

            this.pendingReqs.push( new VoxRequest(path, nextDelay, this.audioContext) );
            nextDelay = 0;
        }

        // Stop pumping when we're out of IDs to queue and nothing is playing
        if (this.currentIds.length       <= 0)
        if (this.pendingReqs.length      <= 0)
        if (this.scheduledBuffers.length <= 0)
            return this.stop();

        this.pumpTimer = setTimeout(this.pump.bind(this), 100);
    }

    private schedule() : void
    {
        // Stop scheduling if there are no pending requests
        if (!this.pendingReqs[0] || !this.pendingReqs[0].isDone)
            return;

        // Don't schedule if more than 5 nodes are, as not to blow any buffers
        if (this.scheduledBuffers.length > 5)
            return;

        let req = this.pendingReqs.shift()!;

        // If the next request errored out (buffer missing), skip it
        if (!req.buffer)
        {
            console.log('VOX CLIP SKIPPED:', req.path);
            return this.schedule();
        }

        // If this is the first clip being played, start from current wall-clock
        if (this.nextBegin === 0)
            this.nextBegin = this.audioContext.currentTime;

        console.log('VOX CLIP QUEUED:', req.path, req.buffer.duration, this.nextBegin);

        // Base latency not available in some browsers
        let latency = (this.audioContext.baseLatency || 0.01) + 0.15;
        let node    = this.audioContext.createBufferSource();
        let rate    = req.forceRate || this.currentSettings!.rate || 1;
        node.buffer = req.buffer;

        // Remap rate from 0.1..1.9 to 0.8..1.5
        if      (rate < 1) rate = (rate * 0.2) + 0.8;
        else if (rate > 1) rate = (rate * 0.5) + 0.5;

        // Calculate delay and duration based on playback rate
        let delay    = req.delay * (1 / rate);
        let duration = node.buffer.duration * (1 / rate);

        node.playbackRate.value = rate;
        node.connect(this.gainNode);
        node.start(this.nextBegin + delay);

        this.scheduledBuffers.push(node);
        this.nextBegin += (duration + delay - latency);

        // Fire on-first-speak event
        if (!this.begunSpeaking)
        {
            this.begunSpeaking = true;

            if (this.onspeak)
                this.onspeak();
        }

        // Have this buffer node remove itself from the schedule when done
        node.onended = _ =>
        {
            console.log('VOX CLIP ENDED:', req.path);
            let idx = this.scheduledBuffers.indexOf(node);

            if (idx !== -1)
                this.scheduledBuffers.splice(idx, 1);
        };
    }

    private createReverb(file: string, impulse: AudioBuffer) : void
    {
        this.impulses[file]           = this.audioContext.createConvolver();
        this.impulses[file].buffer    = impulse;
        this.impulses[file].normalize = true;
        this.setReverb(this.impulses[file]);
        console.debug('VOX REVERB LOADED:', file);
    }

    private setReverb(reverb?: ConvolverNode) : void
    {
        if (this.currentReverb)
        {
            this.currentReverb.disconnect();
            this.currentReverb = undefined;
        }

        this.filterNode.disconnect();

        if (reverb)
        {
            this.currentReverb = reverb;
            this.filterNode.connect(reverb);
            reverb.connect(this.audioContext.destination);
        }
        else
            this.filterNode.connect(this.audioContext.destination);
    }
}