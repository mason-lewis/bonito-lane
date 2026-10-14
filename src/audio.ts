/** Original, locally synthesized ambience. No network assets or autoplay. */
export class CoastalAudio {
  enabled = false;
  volume = .22;
  private context?: AudioContext;
  private master?: GainNode;
  private nextChord = 0;
  private chordIndex = 0;
  private readonly chords = [
    [130.81, 164.81, 196, 246.94],
    [110, 130.81, 164.81, 196],
    [87.31, 130.81, 174.61, 220],
    [98, 146.83, 196, 261.63],
  ];

  get status() {
    if (!this.enabled) return 'Off';
    return this.context?.state === 'running' ? 'Playing' : 'Paused';
  }

  async toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) { await this.context?.suspend(); return; }
    try {
      if (!this.context) this.create();
      await this.context!.resume();
      this.update();
    } catch (error) {
      this.enabled = false;
      throw error;
    }
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master && this.context) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, .08);
  }

  async setHidden(hidden: boolean) {
    if (!this.context) return;
    if (hidden) await this.context.suspend();
    else if (this.enabled) await this.context.resume();
  }

  update() {
    const context = this.context;
    if (!this.enabled || !context || context.state !== 'running') return;
    if (this.nextChord < context.currentTime) this.nextChord = context.currentTime + .08;
    while (this.nextChord < context.currentTime + 1) {
      const chord = this.chords[this.chordIndex++ % this.chords.length];
      chord.forEach((frequency, index) => this.note(frequency, this.nextChord, 9, index));
      this.note(chord[2] * 2, this.nextChord + 2.5, 2.8, 1, true);
      this.note(chord[1] * 2, this.nextChord + 6, 2.8, 2, true);
      this.nextChord += 8;
    }
  }

  private create() {
    const context = this.context = new AudioContext();
    const master = this.master = context.createGain();
    master.gain.value = this.volume;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18; compressor.knee.value = 20; compressor.ratio.value = 3;
    master.connect(compressor).connect(context.destination);
    this.nextChord = context.currentTime + .08;

    // A slowly modulated noise wash suggests surf without a recorded loop.
    const noise = context.createBuffer(2, context.sampleRate * 6, context.sampleRate);
    let seed = 17022;
    for (let channel = 0; channel < 2; channel++) {
      const samples = noise.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        samples[i] = (seed / 0xffffffff) * 2 - 1;
      }
    }
    const waves = context.createBufferSource(); waves.buffer = noise; waves.loop = true;
    const highpass = context.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 180;
    const lowpass = context.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = 1100;
    const swell = context.createGain(); swell.gain.value = .055;
    const lfo = context.createOscillator(); lfo.frequency.value = .085;
    const depth = context.createGain(); depth.gain.value = .035;
    lfo.connect(depth).connect(swell.gain);
    waves.connect(highpass).connect(lowpass).connect(swell).connect(master);
    waves.start(); lfo.start();
  }

  private note(frequency: number, start: number, duration: number, index: number, pluck = false) {
    const context = this.context!;
    const oscillator = context.createOscillator();
    oscillator.type = pluck ? 'sine' : 'triangle';
    oscillator.frequency.value = frequency;
    oscillator.detune.value = [-3, 2, -1, 3][index];
    const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = pluck ? 1600 : 650;
    const gain = context.createGain();
    const pan = context.createStereoPanner(); pan.pan.value = (index - 1.5) * .24;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(pluck ? .07 : .085, start + (pluck ? .035 : 1.8));
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(filter).connect(gain).connect(pan).connect(this.master!);
    oscillator.onended = () => { oscillator.disconnect(); filter.disconnect(); gain.disconnect(); pan.disconnect(); };
    oscillator.start(start); oscillator.stop(start + duration + .1);
  }
}
