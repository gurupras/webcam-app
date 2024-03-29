import Vue from 'vue'
import deepmerge from 'deepmerge'
import Flat from 'flat'

import ProxyMediaStream from '@gurupras/proxy-media-stream'

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

try {
  Vue.config.productionTip = false
} catch (e) {
}

class WebcamApp {
  constructor (defaultConstraints = defaultUserMediaConstraints(), options = defaultOptions(), VueClass = Vue) {
    if (!options) {
      options = defaultOptions()
    }
    options = deepmerge(defaultOptions, options)

    return new VueClass({
      computed: {
        lastUserMediaConstraintsKey () {
          return options.keys.lastUserMediaConstraintsKey
        },
        lastUserMediaVideoDeviceKey () {
          return options.keys.lastUserMediaVideoDeviceKey
        },
        lastUserMediaAudioDeviceKey () {
          return options.keys.lastUserMediaAudioDeviceKey
        }
      },
      data () {
        return {
          selfVideoStream: undefined,
          selfAudioStream: undefined,
          selfWebcamStream: undefined,
          micPermissionState: 'prompt',
          cameraPermissionState: 'prompt',
          lastUserMediaConstraints: undefined,
          selfAudioTrackEnabled: false,
          selfVideoTrackEnabled: false,
          lastVideoInputDeviceId: 'default',
          lastAudioInputDeviceId: 'default',
          lastAudioOutputDeviceId: 'default'
        }
      },
      watch: {
        lastVideoInputDeviceId (v) {
          const { lastUserMediaVideoDeviceKey } = this
          localStorage.setItem(lastUserMediaVideoDeviceKey, v)
        },
        lastAudioInputDeviceId (v) {
          const { lastUserMediaAudioDeviceKey } = this
          localStorage.setItem(lastUserMediaAudioDeviceKey, v)
        },
        lastUserMediaConstraints: {
          handler: function (v, o) {
            const { lastUserMediaConstraintsKey } = this

            const newVideoDeviceId = this.getSelectedDeviceId('video', v)
            const oldVideoDeviceId = this.getSelectedDeviceId('video', o)
            const lastVideoDeviceId = newVideoDeviceId || oldVideoDeviceId
            if (lastVideoDeviceId) {
              this.lastVideoInputDeviceId = lastVideoDeviceId
            }

            const newAudioDeviceId = this.getSelectedDeviceId('audio', v)
            const oldAudioDeviceId = this.getSelectedDeviceId('audio', o)
            const lastAudioDeviceId = newAudioDeviceId || oldAudioDeviceId
            if (lastAudioDeviceId) {
              this.lastAudioInputDeviceId = lastAudioDeviceId
            }
            localStorage.setItem(lastUserMediaConstraintsKey, JSON.stringify(v))
          },
          deep: true
        },
        selfWebcamStream (v, o) {
          this.$emit('webcam-stream', { newStream: v, oldStream: o })
        },
        selfVideoStream (v, o) {
          if (!v && !this.selfAudioStream) {
            this.selfWebcamStream = undefined
          }
        },
        selfAudioStream (v, o) {
          if (!v && !this.selfVideoStream) {
            this.selfWebcamStream = undefined
          }
        }
      },
      methods: {
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
        },
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
        },

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
          const error = new Error(msg)
          Object.assign(error, {
            name: err.name,
            domException: err
          })
          // TODO: Remove the $emit call in v1.0
          this.$emit('error', error)
          throw error
        },
        async requestCamera () {
          const { lastUserMediaConstraints } = this
          const defaults = this.defaultUserMediaConstraints()
          if (!lastUserMediaConstraints.video) {
            lastUserMediaConstraints.video = defaults.video
            this._restoreDeviceId(lastUserMediaConstraints, 'video', this.lastUserMediaVideoDeviceKey)
          }
          if (!this.selfAudioStream || this.selfAudioStream.getTracks().length === 0) {
            // No existing audio stream. Don't request one now.
            lastUserMediaConstraints.audio = false
          }
          try {
            // console.log(`requestCamera: constraints: ${JSON.stringify(constraints)}`)
            const stream = await navigator.mediaDevices.getUserMedia(lastUserMediaConstraints)
            // We just requested camera
            this.selfVideoTrackEnabled = true
            const { videoStream, audioStream } = ProxyMediaStream.splitStream(stream)
            await this.updateVideoStream(videoStream)
            await this.updateAudioStream(audioStream)
            // Ensure that the audio track is in the right state
            await this.$nextTick()
            const audioTrack = stream.getAudioTracks()[0]
            if (audioTrack) {
              audioTrack.enabled = this.selfAudioTrackEnabled
            }
            this.$emit(WebcamStreamUpdateEvent)
          } catch (err) {
            this.handleError(err, 'webcam', 'video', 'cameraPermissionState')
          }
        },
        async requestMicrophone () {
          const { lastUserMediaConstraints } = this
          const defaults = await this.defaultUserMediaConstraints()
          if (!lastUserMediaConstraints.audio) {
            lastUserMediaConstraints.audio = defaults.audio
            this._restoreDeviceId(lastUserMediaConstraints, 'audio', this.lastUserMediaAudioDeviceKey)
          }
          if (!this.selfVideoStream || this.selfVideoStream.getTracks().length === 0) {
            // No existing video stream. Don't request one now.
            lastUserMediaConstraints.video = false
          }
          try {
            // console.log(`requestMicrophone: constraints: ${JSON.stringify(constraints)}`)
            const stream = await navigator.mediaDevices.getUserMedia(lastUserMediaConstraints)
            // We just requested microphone
            this.selfAudioTrackEnabled = true
            const { videoStream, audioStream } = ProxyMediaStream.splitStream(stream)
            await this.updateVideoStream(videoStream)
            await this.updateAudioStream(audioStream)
            // Ensure that the video track is in the right state
            await this.$nextTick()
            const videoTrack = stream.getVideoTracks()[0]
            if (videoTrack) {
              videoTrack.enabled = this.selfVideoTrackEnabled
            }
            this.$emit(WebcamStreamUpdateEvent)
          } catch (err) {
            this.handleError(err, 'microphone', 'audio', 'micPermissionState')
          }
        },
        _addDeviceId (constraints, deviceId, device) {
          let { [device]: deviceConstraints } = constraints
          if (!deviceConstraints || typeof deviceConstraints === 'boolean') {
            deviceConstraints = {}
            this.$set(constraints, 'device', deviceConstraints)
          }
          this.$set(deviceConstraints, 'deviceId', { ideal: [deviceId] })
        },
        _restoreDeviceId (constraints, device, key) {
          const lastUsedDeviceId = localStorage.getItem(key)
          if (lastUsedDeviceId) {
            this._addDeviceId(constraints, lastUsedDeviceId, device)
          }
        },
        /**
         *
         * @param {String} device The device to check for. 'video|audio'
         * @returns {String|null} The device ID if one was found, null otherwise
         */
        getSelectedDeviceId (device, constraints = this.lastUserMediaConstraints) {
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
        },
        /**
         * Check if a current device is specified in lastUserMediaConstraints
         *
         * @param {String} device `'audio'`|`'video'`
         * @param {String} deviceId The device ID to check
         */
        isSelected (device, deviceId) {
          const existingDeviceId = this.getSelectedDeviceId(device)
          return deviceId === existingDeviceId
        },
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
          const newConstraints = JSON.parse(JSON.stringify(lastUserMediaConstraints))
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
            this[deviceKey] = deviceId
          } else {
            // Try specific
            mediaConstraints.deviceId = { ideal: [deviceId] }
            if (selfWebcamStream) {
              const newStream = await navigator.mediaDevices.getUserMedia(newConstraints)
              this.lastUserMediaConstraints = newConstraints
              const { videoStream, audioStream } = ProxyMediaStream.splitStream(newStream)
              await this.updateVideoStream(videoStream)
              await this.updateAudioStream(audioStream)
              this.$emit(WebcamStreamUpdateEvent)
            }
          }
        },
        updateVideoStream (stream) {
          return this.updateStream({
            name: 'selfVideoStream',
            fn: 'getVideoTracks',
            stream
          })
        },
        updateAudioStream (stream) {
          return this.updateStream({
            name: 'selfAudioStream',
            fn: 'getAudioTracks',
            stream
          })
        },
        async updateStream ({ name, fn, stream }) {
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
          await this.onStreamUpdated(newWebcamStream)
          this.selfWebcamStream = newWebcamStream
        },
        async onStreamUpdated () {
        },
        async stopCamera () {
          await this.updateVideoStream()
          this.$emit(WebcamStreamUpdateEvent)
        },
        async stopMicrophone () {
          await this.updateAudioStream()
          this.$emit(WebcamStreamUpdateEvent)
        },
        async enumerateDevices (type, devices) {
          if (!devices) {
            devices = await navigator.mediaDevices.enumerateDevices()
          }
          return devices.filter(device => type ? device.kind === type : true)
        },
        enumerateVideoInputDevices (devices) {
          return this.enumerateDevices('videoinput', devices)
        },
        enumerateAudioInputDevices (devices) {
          return this.enumerateDevices('audioinput', devices)
        },
        enumerateAudioOutputDevices (devices) {
          return this.enumerateDevices('audiooutput', devices)
        }
      },
      created () {
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
              this[lastDeviceIdKey] = lastDeviceId
              const deviceConstraints = unflattened[device]
              if (!deviceConstraints) {
                // This is probably set to false. Nothing to do here
                continue
              }
              this._addDeviceId(unflattened, lastDeviceId, device)
            }
            this.lastUserMediaConstraints = unflattened
          } catch (e) {
          }
        } else {
          this.lastUserMediaConstraints = defaults
        }
      }
    })
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
