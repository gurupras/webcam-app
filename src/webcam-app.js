const Emittery = require('emittery')
const onChange = require('on-change')
const deepmerge = require('deepmerge')
const ProxyMediaStream = require('@gurupras/proxy-media-stream')

const LastUserMediaConstraintsKey = '__webcam-app__:lastUserMediaConstraints'

class WebcamApp {
  constructor (lastUserMediaConstraintsKey = LastUserMediaConstraintsKey, defaultConstraints = defaultUserMediaConstraints()) {
    new Emittery().bindMethods(this)
    Object.assign(this, {
      selfVideoStream: undefined,
      selfAudioStream: undefined,
      selfWebcamStream: undefined,
      micPermissionState: 'prompt',
      cameraPermissionState: 'prompt',
      lastUserMediaConstraints: defaultConstraints,
      _lastUserMediaConstraintsKey: lastUserMediaConstraintsKey
    })

    this.setDefaultUserMediaConstraints(defaultConstraints)
    // Override lastUsedConstraints if it is present in localStorage
    let lastUsedConstraints = localStorage.getItem(LastUserMediaConstraintsKey)
    if (lastUsedConstraints) {
      try {
        lastUsedConstraints = JSON.parse(lastUsedConstraints)
        this.lastUserMediaConstraints = deepmerge(this.lastUserMediaConstraints, lastUsedConstraints)
      } catch (e) {
      }
    }

    const proxy = onChange(this, (path, v, o) => {
      switch (path) {
        case 'lastUserMediaConstraints':
          localStorage.setItem(LastUserMediaConstraintsKey, JSON.stringify(v))
          break
        case 'selfWebcamStream':
          this.emit('webcam-stream', { newStream: v, oldStream: o })
          break
        case 'selfVideoStream':
          if (!v && !this.selfAudioStream) {
            proxy.selfWebcamStream = undefined
          }
          break
        case 'selfAudioStream':
          if (!v && !this.selfVideoStream) {
            proxy.selfWebcamStream = undefined
          }
          break
      }
      this.emit('watch', { path, v, o })
    }, {
      isShallow: true
    })
    return proxy
  }

  get lastUserMediaConstraintsKey () {
    return this._lastUserMediaConstraintsKey
  }

  setDefaultUserMediaConstraints (constraints) {
    let copy
    let fn
    if (constraints) {
      copy = deepmerge({}, constraints)
      fn = () => deepmerge({}, copy)
    } else {
      fn = () => constraints
    }
    this.defaultUserMediaConstraints = fn
  }

  async checkPermissions () {
    navigator.permissions.query({ name: 'microphone' })
      .then((response) => {
        this.micPermissionState = response.state
      }).catch(() => {
        this.micPermissionState = 'denied'
      })
    navigator.permissions.query({ name: 'camera' })
      .then(response => {
        this.cameraPermissionState = response.state
      }).catch(() => {
        this.cameraPermissionState = 'denied'
      })
  }

  handleError (err, device, userMediaConstraintsKey, statePropertyName) {
    let msg
    switch (err.name) {
      case 'AbortError':
        msg = 'Unknown error has occured. Reset your tab, browser, or device and try again.'
        break
      case 'NotAllowedError':
        this[statePropertyName] = 'denied'
        msg = `You have disabled ${device} access on this website. Enable ${device} access before use.`
        break
      case 'NotFoundError':
        msg = `No device found. Ensure your ${device} is connected.`
        break
      case 'NotReadableError':
        msg = `Unable to access ${device}. Hardware error.`
        break
      case 'OverconstrainedError':
        this.lastUserMediaConstraints = {
          ...this.lastUserMediaConstraints,
          [userMediaConstraintsKey]: this.defaultUserMediaConstraints()[userMediaConstraintsKey]
        }
        // TODO: Should we call getUserMedia here?
        break
      case 'SecurityError':
        msg = `You have disabled ${device} access on this website. Enable ${device} access before use.`
        break
      case 'TypeError':
        msg = 'Bad constraints.'
    }
    err.message = msg
    // TODO: Remove the emit call in v2.0
    this.emit('error', err)
    throw err
  }

  async requestCamera () {
    const { lastUserMediaConstraints } = this
    const defaults = this.defaultUserMediaConstraints()
    if (!lastUserMediaConstraints.video) {
      lastUserMediaConstraints.video = defaults.video
    }
    if (!this.selfAudioStream || this.selfAudioStream.getTracks().length === 0) {
      // No existing audio stream. Don't request one now.
      lastUserMediaConstraints.audio = false
    }
    try {
      // console.log(`requestCamera: constraints: ${JSON.stringify(constraints)}`)
      const stream = await navigator.mediaDevices.getUserMedia(lastUserMediaConstraints)
      const { videoStream, audioStream } = ProxyMediaStream.splitStream(stream)
      this.updateVideoStream(videoStream)
      this.updateAudioStream(audioStream)
    } catch (err) {
      this.handleError(err, 'webcam', 'video', 'cameraPermissionState')
    }
  }

  async requestMicrophone () {
    const { lastUserMediaConstraints } = this
    const defaults = await this.defaultUserMediaConstraints()
    if (!lastUserMediaConstraints.audio) {
      lastUserMediaConstraints.audio = defaults.audio
    }
    if (!this.selfVideoStream || this.selfVideoStream.getTracks().length === 0) {
      // No existing video stream. Don't request one now.
      lastUserMediaConstraints.video = false
    }
    try {
      // console.log(`requestMicrophone: constraints: ${JSON.stringify(constraints)}`)
      const stream = await navigator.mediaDevices.getUserMedia(lastUserMediaConstraints)
      const { videoStream, audioStream } = ProxyMediaStream.splitStream(stream)
      this.updateVideoStream(videoStream)
      this.updateAudioStream(audioStream)
    } catch (err) {
      this.handleError(err, 'microphone', 'audio', 'micPermissionState')
    }
  }

  /**
   * Check if a current device is specified in lastUserMediaConstraints
   *
   * @param {String} device `'audio'`|`'video'`
   * @param {String} deviceID The device ID to check
   */
  isSelected (device, deviceId) {
    const { lastUserMediaConstraints } = this
    const { [device]: { deviceId: existingDeviceId = {} } } = lastUserMediaConstraints
    const { exact } = existingDeviceId
    return deviceId === exact
  }

  /**
   * Update media constraints based on camera/mic input selected by the user
   * and invoke getUserMedia with the new set of constraints.
   * This method may update selfVideoStream, selfAudioStream and selfWebcamStream
   *
   * @param {String} type `'videoInput'`|`'audioInput'`
   * @param {Object} event Event
   */
  async switchDevice (type, deviceId) {
    const { lastUserMediaConstraints } = this
    let mediaConstraints
    switch (type) {
      case 'videoInput':
        mediaConstraints = lastUserMediaConstraints.video
        break
      case 'audioInput':
        mediaConstraints = lastUserMediaConstraints.audio
        break
    }
    const { optional } = mediaConstraints
    const sourceIDEntry = optional.find(x => x.sourceId)
    sourceIDEntry.sourceId = deviceId

    const newStream = await navigator.mediaDevices.getUserMedia(lastUserMediaConstraints)
    const { videoStream, audioStream } = ProxyMediaStream.splitStream(newStream)
    this.updateVideoStream(videoStream)
    this.updateAudioStream(audioStream)
  }

  updateVideoStream (stream) {
    return this.updateStream({
      name: 'selfVideoStream',
      fn: 'getVideoTracks',
      stream
    })
  }

  updateAudioStream (stream) {
    return this.updateStream({
      name: 'selfAudioStream',
      fn: 'getAudioTracks',
      stream
    })
  }

  updateStream ({ name, fn, stream }) {
    if (stream) {
      this[name] = new ProxyMediaStream(stream)
    } else {
      this[name] = null
    }
    const { selfWebcamStream } = this
    const oldTracks = (selfWebcamStream && selfWebcamStream[fn]()) || []
    let newTracks = (stream && stream[fn]()) || []
    const newWebcamStream = new ProxyMediaStream()
    oldTracks.forEach(t => {
      t.stop()
      // TODO: This does not belong here
      t.dispatchEvent(new CustomEvent('ended'))
    })
    // console.log(`updateStream: ${name}: Stopped ${oldTracks.length}(${JSON.stringify(oldTracks.map(t => t.type))}) tracks`)
    const allTracks = (selfWebcamStream && selfWebcamStream.getTracks()) || []
    const filteredTracks = allTracks.filter(x => !oldTracks.includes(x))
    newTracks = Array.from(new Set([...filteredTracks, ...newTracks]))
    if (newTracks.length === 0) {
      this.selfWebcamStream = undefined
      return
    }
    newTracks.forEach(t => newWebcamStream.addTrack(t))
    this.selfWebcamStream = newWebcamStream
  }

  stopCamera () {
    this.updateVideoStream()
  }

  stopMicrophone () {
    this.updateAudioStream()
  }
}

function defaultUserMediaConstraints () {
  return {
    video: {
      optional: [
        { minFrameRate: 30 },
        { maxFrameRate: 30 },
        { sourceId: 'default' }
      ]
    },
    audio: {
      optional: [
        { echoCancellation: true },
        { noiseSuppression: true },
        { autoGainControl: true },
        { googEchoCancellation: true },
        { googEchoCancellation2: true },
        { googNoiseSuppression: true },
        { googNoiseSuppression2: true },
        { googAutoGainControl: true },
        { googAutoGainControl2: true },
        { googHighpassFilter: true },
        { googTypingNoiseDetection: true },
        { googAudioMirroring: false },
        { sourceId: 'default' }
      ]
    }
  }
}

export default WebcamApp
