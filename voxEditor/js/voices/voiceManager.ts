/** Rail Announcements Generator. By Roy Curtis, MIT license, 2018 */

import * as fs from "fs";
import {Files} from "../util/files";
import * as path from "path";
import {VoxEditor} from "../voxEditor";
import Mp3Encoder = lamejs.Mp3Encoder;

/** Manages available voices and clips */
export class VoiceManager
{
    /** Relative path to find voices in */
    private static readonly VOX_DIR   : string = '../data/vox';
    /** Pattern to match voice folder names */
    private static readonly VOX_REGEX : RegExp = /(.+)_([a-z]{2}-[A-Z]{2})/;

    /** List of discovered and available voices */
    public  readonly list         : CustomVoice[];
    /** Audio output through which clips are played */
    private readonly audioContext : AudioContext;

    /** Current clip's audio buffer */
    public  currentClip?    : AudioBuffer;
    /** Current clip's file path */
    public  currentPath?    : string;
    /** Audio buffer node holding and playing the current voice clip */
    private currentBufNode? : AudioBufferSourceNode;

    public constructor()
    {
        this.list            = [];
        this.audioContext    = new AudioContext();
        CustomVoice.basePath = VoiceManager.VOX_DIR;

        // Discover valid voice folders
        this.discoverVoices();

        // Create new voice if none found
        if (VoxEditor.config.voicePath === '')
            this.createNewVoice();
    }

    /** Makes a relative path out of the given key */
    public keyToPath(key: string) : string
    {
        if (VoxEditor.config.voicePath === '')
            throw Error('Attempted to get path of key with no voice set');

        return path.join(VoxEditor.config.voicePath, `${key}.mp3`);
    }

    /** Checks whether a clip for the given key exists on disk */
    public hasClip(key: string) : boolean
    {
        let clipPath = this.keyToPath(key);

        // If no voice path is set, skip
        if (!clipPath)
            return false;

        return fs.existsSync(clipPath) && fs.lstatSync(clipPath).isFile();
    }

    /** Loads the given audio buffer as a clip for the current key */
    public loadFromBuffer(buffer: AudioBuffer) : void
    {
        let key = VoxEditor.views.phrases.currentKey;

        if ( Strings.isNullOrEmpty(key) )
            throw Error('Attempted to load with no key selected');

        this.currentClip = buffer;
        this.currentPath = this.keyToPath(key!);
    }

    /** Attempts to load the current key's voice clip from disk, if it exists */
    public loadFromDisk() : void
    {
        this.unload();

        let key = VoxEditor.views.phrases.currentKey;

        if ( Strings.isNullOrEmpty(key) )
            throw Error('Attempted to load with no key selected');

        this.currentPath = this.keyToPath(key!);

        if ( !this.currentPath || !this.hasClip(key!) )
            return VoxEditor.views.tapedeck.handleClipLoad(key!);
        else
            VoxEditor.views.tapedeck.handleClipLoading(key!);

        // For some reason, we have to copy the given buffer using slice. Else, repeat
        // calls to this method for the same clip will silently fail, or hang. It's
        // possible because decodeAudioData holds a copy of the given buffer, preventing
        // the release of resources held by readFileSync.

        // TODO: BUG: There appears to be a Chromium bug, where some clips repeat
        // themselves after being loaded multiple times. It may just be an issue with
        // the mp3 files exported from Audacity.

        let buffer       = fs.readFileSync(this.currentPath);
        let arrayBuffer  = buffer.buffer.slice(0);
        this.audioContext.decodeAudioData(arrayBuffer)
            .then(audio =>
            {
                this.currentClip = audio;
                VoxEditor.views.tapedeck.handleClipLoad(key!);
            })
            .catch( err => VoxEditor.views.tapedeck.handleClipFail(key!, err) );
    }

    /** Unloads the current clip from memory */
    public unload() : void
    {
        if (!this.currentClip)
            return;

        this.stopClip();

        this.currentClip = undefined;
        this.currentPath = undefined;

        VoxEditor.views.tapedeck.handleClipUnload();
    }

    /** Plays the currently loaded clip, if any */
    public playClip(bounds?: [number, number]) : void
    {
        if (!this.currentClip)
            return;

        this.stopClip();
        this.currentBufNode         = this.audioContext.createBufferSource();
        this.currentBufNode.buffer  = this.currentClip;
        this.currentBufNode.onended = _ => { this.stopClip(); };

        this.currentBufNode.connect(this.audioContext.destination);
        VoxEditor.views.tapedeck.handleBeginPlay();

        // If given bounds, only play within those bounds
        if ( bounds && (bounds[0] > 0 || bounds[1] < 1) )
        {
            let duration = this.currentClip.duration;
            let begin    = duration * bounds[0];
            let end      = (duration * bounds[1]) - begin;

            this.currentBufNode.start(0, begin, end);
        }
        else
            this.currentBufNode.start();
    }

    /** Stops playing the current clip, if any */
    public stopClip() : void
    {
        if (!this.currentBufNode)
            return;

        this.currentBufNode.onended = null;
        this.currentBufNode.stop();
        this.currentBufNode.disconnect();
        this.currentBufNode = undefined;

        VoxEditor.views.tapedeck.handleEndPlay();
    }

    /** Scales the current clip's volume (gain) by given amount */
    public scaleClip(factor: number) : void
    {
        if (!this.currentClip)
            return;

        let data = this.currentClip.getChannelData(0);

        for (let i = 0; i < data.length; i++)
            data[i] *= factor;
    }

    /** Saves the current clip to disk as an MP3 */
    public saveClip(bounds?: [number, number]) : void
    {
        if (!this.currentClip || !this.currentPath)
            throw Error('Attempted to save without state nor path');
        else
            this.stopClip();

        // https://github.com/zhuker/lamejs/issues/10#issuecomment-141720630
        let blocks : Int8Array[] = [];

        let intChannel : Int16Array;
        let encoder    = new Mp3Encoder(1, this.currentClip.sampleRate, 128);
        let channel    = this.currentClip.getChannelData(0);
        let blockSize  = 1152;
        let length     = channel.length;
        let totalSize  = 0;

        // First, clip the data to the given bounds and replace original buffer

        if ( bounds && (bounds[0] > 0 || bounds[1] < 1) )
        {
            let lower = length * bounds[0];
            let upper = length * bounds[1];
            let rate  = this.currentClip.sampleRate;

            channel = channel.slice(lower, upper);
            length  = channel.length;

            this.currentClip = this.audioContext.createBuffer(1, length, rate);
            this.currentClip.copyToChannel(channel, 0);
        }

        // Then, convert the clip data from -1..1 floats to -32768..32767 integers

        intChannel = new Int16Array(length);

        for (let i = 0; i < length; i++)
        {
            let n = channel[i];
            let v = n < 0
                ? n * 32768
                : n * 32767;

            intChannel[i] = Math.max( -32768, Math.min(32768, v) );
        }

        // Then, encode the clip's data into mp3 chunks

        for (let i = 0; i < length; i += blockSize)
        {
            let bufBlock = intChannel.subarray(i, i + blockSize);
            let mp3Block = encoder.encodeBuffer(bufBlock);

            if (mp3Block.length > 0)
            {
                blocks.push(mp3Block);
                totalSize += mp3Block.length;
            }
        }

        // Then, finalize the MP3

        let finalBlock = encoder.flush();

        if (finalBlock.length > 0)
        {
            blocks.push(finalBlock);
            totalSize += finalBlock.length;
        }

        // Finally, write it to disk

        let bytes  = Buffer.alloc(totalSize);
        let offset = 0;

        blocks.forEach(block =>
        {
            bytes.set(block, offset);
            offset += block.length;
        });

        fs.writeFileSync(this.currentPath, bytes, { encoding : null });
        VoxEditor.views.phrases.handleSave();
    }

    /** Looks for and keeps track of any voices available on disk */
    private discoverVoices() : void
    {
        fs.readdirSync(VoiceManager.VOX_DIR)
            .map( name => path.join(VoiceManager.VOX_DIR, name) )
            .filter(Files.isDir)
            .forEach(dir =>
            {
                let name  = path.basename(dir);
                let parts = name.match(VoiceManager.VOX_REGEX);

                // Skip voices that do not match the format
                if (!parts)
                    return;

                this.list.push( new CustomVoice(parts[1], parts[2]) );

                // If no voice configured yet, choose the first one found
                if (VoxEditor.config.voicePath === '')
                    VoxEditor.config.voicePath = dir;
            });
    }

    /** Creates a new voice directory on disk */
    private createNewVoice() : void
    {
        let newName  = 'NuVoice';
        let newVoice = path.join(VoiceManager.VOX_DIR, newName);

        fs.mkdirSync(newVoice);
        VoxEditor.config.voicePath = newVoice;
        this.list.push( new CustomVoice(newName, 'en-GB') );

        alert(`No voices were found, so a new one was made at '${newVoice}'`);
    }
}