import Emittery from 'emittery'
import { ref } from '@vue/reactivity'
import { watch } from '@vue-reactivity/watch'
import deepmerge from 'deepmerge'
import Flat from 'flat'

import ProxyMediaStream from '@gurupras/proxy-media-stream'
import { nextTick } from './utils'

const LastUserMediaConstraintsKey = '__webcam-app__:lastUserMediaConstraints'
const LastUserMediaVideoDeviceKey = '__webcam-app__:lastUserDevice:video'
const LastUserMediaAudioDeviceKey = '__webcam-app__:lastUserDevice:audio'

export const WebcamStreamUpdateEvent = 'webcam-stream-update'

const defaultOptions = () => {
  return {
    keys: {
      lastUserMediaConstraintsKey: LastUserMediaConstraintsKey,
      lastUserMediaVideoDeviceKey: LastUserMediaVideoDeviceKey,
      lastUserMediaAudioDeviceKey: LastUserMediaAudioDeviceKey
    }
  }
}
class WebcamApp {
  constructor (defaultConstraints = defaultUserMediaConstraints(), options = defaultOptions()) {
    if (!options) {
      options = defaultOptions()
    }

    const emittery = new Emittery()
    this.on = emittery.on.bind(emittery)
    this.off = emittery.off.bind(emittery)
    this.emit = emittery.emit.bind(emittery)
    // For backwards compatibility
    this.$on = emittery.on.bind(emittery)
    this.$off = emittery.off.bind(emittery)
    this.$emit = emittery.emit.bind(emittery)

    this.options = deepmerge(defaultOptions, options)

    this.selfVideoStream = ref(undefined)
    this.selfAudioStream = ref(undefined)
    this.selfWebcamStream = ref(undefined)
    this.micPermissionState = ref('prompt')
    this.cameraPermissionState = ref('prompt')
    this.lastUserMediaConstraints = ref(undefined)
    this.selfAudioTrackEnabled = ref(false)
    this.selfVideoTrackEnabled = ref(false)
    this.lastVideoInputDeviceId = ref('default')
    this.lastAudioInputDeviceId = ref('default')
    this.lastAudioOutputDeviceId = ref('default')

    this.watches = []

    this.watches.push(watch(this.lastVideoInputDeviceId, (v) => {
      const { lastUserMediaVideoDeviceKey } = this
      localStorage.setItem(lastUserMediaVideoDeviceKey, v)
    }))
    this.watches.push(watch(this.lastAudioInputDeviceId, (v) => {
      const { lastUserMediaAudioDeviceKey } = this
      localStorage.setItem(lastUserMediaAudioDeviceKey, v)
    }))
    this.watches.push(watch(this.lastUserMediaConstraints, (v, o) => {
      const { lastUserMediaConstraintsKey } = this

      const newVideoDeviceId = this.getSelectedDeviceId('video', v)
      const oldVideoDeviceId = this.getSelectedDeviceId('video', o)
      const lastVideoDeviceId = newVideoDeviceId || oldVideoDeviceId
      if (lastVideoDeviceId) {
        this.lastVideoInputDeviceId.value = lastVideoDeviceId
      }

      const newAudioDeviceId = this.getSelectedDeviceId('audio', v)
      const oldAudioDeviceId = this.getSelectedDeviceId('audio', o)
      const lastAudioDeviceId = newAudioDeviceId || oldAudioDeviceId
      if (lastAudioDeviceId) {
        this.lastAudioInputDeviceId.value = lastAudioDeviceId
      }
      localStorage.setItem(lastUserMediaConstraintsKey, JSON.stringify(v))
    }, {
      deep: true
    }))

    this.watches.push(watch(this.selfWebcamStream, (v, o) => {
      this.emit(WebcamStreamUpdateEvent, { newStream: v, oldStream: o })
    }))
    this.watches.push(watch(this.selfVideoStream, (v, o) => {
      if (!v && !this.selfAudioStream.value) {
        this.selfWebcamStream.value = undefined
      }
    }))
    this.watches.push(watch(this.selfAudioStream, (v, o) => {
      if (!v && !this.selfVideoStream.value) {
        this.selfWebcamStream.value = undefined
      }
    }))

    this.setDefaultUserMediaConstraints(defaultConstraints)
    const { lastUserMediaConstraintsKey, lastUserMediaAudioDeviceKey, lastUserMediaVideoDeviceKey } = this
    let lastUsedConstraints = localStorage.getItem(lastUserMediaConstraintsKey)
    const defaults = this.defaultUserMediaConstraints()
    if (lastUsedConstraints) {
      try {
        lastUsedConstraints = JSON.parse(lastUsedConstraints)
        const flatDefaults = Flat.flatten(defaults)
        const flatLastUsed = Flat.flatten(lastUsedConstraints)
        const flatMerged = deepmerge(flatDefaults, flatLastUsed)
        const unflattened = Flat.unflatten(flatMerged)
        const data = {
          audio: [lastUserMediaAudioDeviceKey, 'lastAudioInputDeviceId'],
          video: [lastUserMediaVideoDeviceKey, 'lastVideoInputDeviceId']
        }
        for (const [device, [storageKey, lastDeviceIdKey]] of Object.entries(data)) {
          const lastDeviceId = localStorage.getItem(storageKey)
          if (!lastDeviceId) {
            continue
          }
          this[lastDeviceIdKey].value = lastDeviceId
          const deviceConstraints = unflattened[device]
          if (!deviceConstraints) {
            // This is probably set to false. Nothing to do here
            continue
          }
          this._addDeviceId(unflattened, lastDeviceId, device)
        }
        this.lastUserMediaConstraints.value = unflattened
      } catch (e) {
      }
    } else {
      this.lastUserMediaConstraints.value = defaults
    }
  }

  get lastUserMediaConstraintsKey () {
    return this.options.keys.lastUserMediaConstraintsKey
  }

  get lastUserMediaVideoDeviceKey () {
    return this.options.keys.lastUserMediaVideoDeviceKey
  }

  get lastUserMediaAudioDeviceKey () {
    return this.options.keys.lastUserMediaAudioDeviceKey
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
        this.micPermissionState.value = response.state
      }).catch(() => {
        this.micPermissionState.value = 'denied'
      })
    navigator.permissions.query({ name: 'camera' })
      .then(response => {
        this.cameraPermissionState.value = response.state
      }).catch(() => {
        this.cameraPermissionState.value = 'denied'
      })
  }

  handleError (err, device, userMediaConstraintsKey, statePropertyName) {
    let msg
    switch (err.name) {
      case 'AbortError':
        msg = 'Unknown error has occured. Reset your tab, browser, or device and try again.'
        break
      case 'NotAllowedError':
        this[statePropertyName].value = 'denied'
        msg = `You have disabled ${device} access on this website. Enable ${device} access before use.`
        break
      case 'NotFoundError':
        msg = `No device found. Ensure your ${device} is connected.`
        break
      case 'NotReadableError':
        msg = `Unable to access ${device}. Hardware error.`
        break
      case 'OverconstrainedError':
        this.lastUserMediaConstraints.value = {
          ...this.lastUserMediaConstraints.value,
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
    const error = new Error(msg)
    Object.assign(error, {
      name: err.name,
      domException: err
    })
    // TODO: Remove the emit call in v1.0
    this.emit('error', error)
    throw error
  }

  async requestCamera () {
    const { lastUserMediaConstraints } = this
    const constraints = { ...lastUserMediaConstraints.value }
    const defaults = this.defaultUserMediaConstraints()
    if (!constraints.video) {
      constraints.video = defaults.video
      if (this.lastVideoInputDeviceId.value) {
        this._addDeviceId(constraints, this.lastVideoInputDeviceId.value, 'video')
      }
    }

    if (!this.selfAudioStream.value || this.selfAudioStream.value.getTracks().length === 0) {
      // No existing audio stream. Don't request one now.
      constraints.audio = false
    }
    lastUserMediaConstraints.value = constraints
    try {
      // console.log(`requestCamera: constraints: ${JSON.stringify(constraints)}`)
      const stream = await navigator.mediaDevices.getUserMedia(lastUserMediaConstraints.value)
      // We just requested camera
      this.selfVideoTrackEnabled.value = true
      const { videoStream, audioStream } = ProxyMediaStream.splitStream(stream)
      await this.updateVideoStream(videoStream)
      await this.updateAudioStream(audioStream)
      // Ensure that the audio track is in the right state
      await nextTick()
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = this.selfAudioTrackEnabled.value
      }
      this.emit(WebcamStreamUpdateEvent)
    } catch (err) {
      this.handleError(err, 'webcam', 'video', 'cameraPermissionState')
    }
  }

  async requestMicrophone () {
    const { lastUserMediaConstraints } = this
    const constraints = { ...lastUserMediaConstraints.value }
    const defaults = await this.defaultUserMediaConstraints()
    if (!constraints.audio) {
      constraints.audio = defaults.audio
      this._addDeviceId(constraints, this.lastAudioInputDeviceId.value, 'audio')
    }

    if (!this.selfVideoStream.value || this.selfVideoStream.value.getTracks().length === 0) {
      // No existing video stream. Don't request one now.
      constraints.video = false
    }
    lastUserMediaConstraints.value = constraints
    try {
      // console.log(`requestMicrophone: constraints: ${JSON.stringify(constraints)}`)
      const stream = await navigator.mediaDevices.getUserMedia(lastUserMediaConstraints.value)
      // We just requested microphone
      this.selfAudioTrackEnabled.value = true
      const { videoStream, audioStream } = ProxyMediaStream.splitStream(stream)
      await this.updateVideoStream(videoStream)
      await this.updateAudioStream(audioStream)
      // Ensure that the video track is in the right state
      await nextTick()
      const videoTrack = stream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.enabled = this.selfVideoTrackEnabled.value
      }
      this.emit(WebcamStreamUpdateEvent)
    } catch (err) {
      this.handleError(err, 'microphone', 'audio', 'micPermissionState')
    }
  }

  _addDeviceId (constraints, deviceId, device) {
    let { [device]: deviceConstraints } = constraints
    if (!deviceConstraints || typeof deviceConstraints === 'boolean') {
      deviceConstraints = {}
      constraints.device = deviceConstraints
    }
    deviceConstraints.deviceId = { ideal: [deviceId] }
  }

  _restoreDeviceId (constraints, device, key) {
    const lastUsedDeviceId = localStorage.getItem(key)
    if (lastUsedDeviceId) {
      const copy = { ...constraints.value }
      this._addDeviceId(copy, lastUsedDeviceId, device)
      constraints.value = copy
    }
  }

  /**
   *
   * @param {String} device The device to check for. 'video|audio'
   * @returns {String|null} The device ID if one was found, null otherwise
   */
  getSelectedDeviceId (device, constraints = this.lastUserMediaConstraints.value) {
    const { [device]: deviceConstraints } = constraints
    if (!deviceConstraints) {
      return null
    }
    const { deviceId: deviceIdEntry = {} } = deviceConstraints
    const { ideal = [], exact } = deviceIdEntry
    if (exact) {
      return exact
    }
    const [existingDeviceId] = ideal
    return existingDeviceId || null
  }

  /**
   * Check if a current device is specified in lastUserMediaConstraints
   *
   * @param {String} device `'audio'`|`'video'`
   * @param {String} deviceId The device ID to check
   */
  isSelected (device, deviceId) {
    const existingDeviceId = this.getSelectedDeviceId(device)
    return deviceId === existingDeviceId
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
    const { lastUserMediaConstraints, selfWebcamStream } = this
    let mediaConstraints
    let deviceKey
    const newConstraints = JSON.parse(JSON.stringify(lastUserMediaConstraints.value))
    switch (type) {
      case 'videoInput':
        mediaConstraints = newConstraints.video
        deviceKey = 'lastVideoInputDeviceId'
        break
      case 'audioInput':
        mediaConstraints = newConstraints.audio
        deviceKey = 'lastAudioInputDeviceId'
        break
      default:
        throw new Error('Unknown device type')
    }
    if (!mediaConstraints) {
      // We don't have active constraints. Just store it as the last used device
      this[deviceKey].value = deviceId
    } else {
      // Try specific
      mediaConstraints.deviceId = { ideal: [deviceId] }
      if (selfWebcamStream.value) {
        const newStream = await navigator.mediaDevices.getUserMedia(newConstraints)
        this.lastUserMediaConstraints.value = newConstraints
        const { videoStream, audioStream } = ProxyMediaStream.splitStream(newStream)
        await this.updateVideoStream(videoStream)
        await this.updateAudioStream(audioStream)
        this.emit(WebcamStreamUpdateEvent)
      }
    }
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

  async updateStream ({ name, fn, stream }) {
    if (stream) {
      this[name].value = new ProxyMediaStream(stream)
    } else {
      this[name].value = null
    }
    const { selfWebcamStream } = this
    const oldTracks = (selfWebcamStream.value && selfWebcamStream.value[fn]()) || []
    let newTracks = (stream && stream[fn]()) || []
    const newWebcamStream = new ProxyMediaStream()
    oldTracks.forEach(t => {
      t.stop()
      // TODO: This does not belong here
      t.dispatchEvent(new CustomEvent('ended'))
    })
    // console.log(`updateStream: ${name}: Stopped ${oldTracks.length}(${JSON.stringify(oldTracks.map(t => t.type))}) tracks`)
    const allTracks = (selfWebcamStream.value && selfWebcamStream.value.getTracks()) || []
    const filteredTracks = allTracks.filter(x => !oldTracks.includes(x))
    newTracks = Array.from(new Set([...filteredTracks, ...newTracks]))
    if (newTracks.length === 0) {
      this.selfWebcamStream.value = undefined
      return
    }
    newTracks.forEach(t => newWebcamStream.addTrack(t))
    await this.onStreamUpdated(newWebcamStream)
    this.selfWebcamStream.value = newWebcamStream
  }

  async onStreamUpdated () {
  }

  async stopCamera () {
    await this.updateVideoStream()
    this.emit(WebcamStreamUpdateEvent)
  }

  async stopMicrophone () {
    await this.updateAudioStream()
    this.emit(WebcamStreamUpdateEvent)
  }

  async enumerateDevices (type, devices) {
    if (!devices) {
      devices = await navigator.mediaDevices.enumerateDevices()
    }
    return devices.filter(device => type ? device.kind === type : true)
  }

  enumerateVideoInputDevices (devices) {
    return this.enumerateDevices('videoinput', devices)
  }

  enumerateAudioInputDevices (devices) {
    return this.enumerateDevices('audioinput', devices)
  }

  enumerateAudioOutputDevices (devices) {
    return this.enumerateDevices('audiooutput', devices)
  }

  destroy () {
    for (const stopWatch of this.watches) {
      stopWatch()
    }
  }
}

function defaultUserMediaConstraints () {
  return {
    video: {
      frameRate: { ideal: 30 },
      deviceId: { ideal: ['default'] }
    },
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      deviceId: { ideal: ['default'] }
    }
  }
}

export {
  WebcamApp
}
