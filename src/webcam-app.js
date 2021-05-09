const Vue = require('vue')
const deepmerge = require('deepmerge')
const Flat = require('flat')

const ProxyMediaStream = require('@gurupras/proxy-media-stream')

const LastUserMediaConstraintsKey = '__webcam-app__:lastUserMediaConstraints'
const LastUserMediaVideoDeviceKey = '__webcam-app__:lastUserDevice:video'
const LastUserMediaAudioDeviceKey = '__webcam-app__:lastUserDevice:audio'

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
          lastUserMediaConstraints: defaultConstraints,
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
            this.updateVideoStream(videoStream)
            this.updateAudioStream(audioStream)
            // Ensure that the audio track is in the right state
            await this.$nextTick()
            const audioTrack = stream.getAudioTracks()[0]
            if (audioTrack) {
              audioTrack.enabled = this.selfAudioTrackEnabled
            }
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
            this.updateVideoStream(videoStream)
            this.updateAudioStream(audioStream)
            // Ensure that the video track is in the right state
            await this.$nextTick()
            const videoTrack = stream.getVideoTracks()[0]
            if (videoTrack) {
              videoTrack.enabled = this.selfVideoTrackEnabled
            }
          } catch (err) {
            this.handleError(err, 'microphone', 'audio', 'micPermissionState')
          }
        },
        _addDeviceId (constraints, deviceId, device) {
          let { [device]: deviceConstraints } = constraints
          if (!deviceConstraints) {
            deviceConstraints = {}
            constraints[device] = deviceConstraints
          }
          let entry = this._getOptionalDeviceIdEntry(device, constraints)
          if (!entry) {
            if (!deviceConstraints.optional) {
              // There is no optional entry
              deviceConstraints.optional = []
            }
            entry = {}
            deviceConstraints.optional.push(entry)
          }
          this.$set(entry, 'sourceId', deviceId)
        },
        _restoreDeviceId (constraints, device, key) {
          const lastUsedDeviceId = localStorage.getItem(key)
          if (lastUsedDeviceId) {
            this._addDeviceId(constraints, lastUsedDeviceId, device)
          }
        },
        _getOptionalDeviceIdEntry (device, constraints) {
          const { [device]: deviceConstraints } = constraints
          if (!deviceConstraints) {
            return null
          }
          const { optional } = deviceConstraints
          if (!optional) {
            return null
          }
          return optional.find(x => x.sourceId)
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
          let { exact: existingDeviceId } = deviceIdEntry
          if (!existingDeviceId) {
            // Check optional constraints
            const { optional = [] } = deviceConstraints
            const deviceConstraint = optional.find(x => x.sourceId)
            if (deviceConstraint) {
              existingDeviceId = deviceConstraint.sourceId
            }
          }
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
          switch (type) {
            case 'videoInput':
              mediaConstraints = lastUserMediaConstraints.video
              deviceKey = 'lastVideoInputDeviceId'
              break
            case 'audioInput':
              mediaConstraints = lastUserMediaConstraints.audio
              deviceKey = 'lastAudioInputDeviceId'
              break
            default:
              throw new Error('Unknown device type')
          }
          if (!mediaConstraints) {
            // We don't have active constraints. Just store it as the last used device
            this[deviceKey] = deviceId
          } else {
            const { optional } = mediaConstraints
            const sourceIDEntry = optional.find(x => x.sourceId)
            sourceIDEntry.sourceId = deviceId
            if (selfWebcamStream) {
              const newStream = await navigator.mediaDevices.getUserMedia(lastUserMediaConstraints)
              const { videoStream, audioStream } = ProxyMediaStream.splitStream(newStream)
              this.updateVideoStream(videoStream)
              this.updateAudioStream(audioStream)
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
        },
        stopCamera () {
          this.updateVideoStream()
        },
        stopMicrophone () {
          this.updateAudioStream()
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
        if (lastUsedConstraints) {
          try {
            lastUsedConstraints = JSON.parse(lastUsedConstraints)
            const defaults = this.defaultUserMediaConstraints()
            // Merge optional constraints of each device
            // These may be out of order, so a straight flatten will not work
            const devices = [...new Set([...Object.keys(defaults), ...Object.keys(lastUsedConstraints)])]
            const constraintsToMerge = [defaults, lastUsedConstraints] // The order matters. We want to override lastUserMediaConstraints with lastUsedConstraints
            const optionalConstraints = {}
            for (const device of devices) {
              const optional = {}
              for (const constraints of constraintsToMerge) {
                const deviceConstraints = constraints[device]
                const { optional: opt = [] } = deviceConstraints
                for (const o of opt) {
                  for (const [k, v] of Object.entries(o)) {
                    optional[k] = v
                  }
                }
                // Delete this from constraints since we're going to merge it back in
                delete deviceConstraints.optional
              }
              optionalConstraints[device] = optional
            }
            const flatDefaults = Flat.flatten(defaults)
            const flatLastUsed = Flat.flatten(lastUsedConstraints)
            const flatMerged = deepmerge(flatDefaults, flatLastUsed)
            const unflattened = Flat.unflatten(flatMerged)
            for (const device of devices) {
              if (!unflattened[device]) {
                continue
              }
              const optional = []
              for (const [k, v] of Object.entries(optionalConstraints[device])) {
                optional.push({ [k]: v })
              }
              unflattened[device].optional = optional
            }
            const data = {
              audio: lastUserMediaAudioDeviceKey,
              video: lastUserMediaVideoDeviceKey
            }
            for (const [device, key] of Object.entries(data)) {
              const lastDeviceId = localStorage.getItem(key)
              const deviceConstraints = unflattened[device]
              if (!deviceConstraints) {
                // This is probably set to false. Nothing to do here
                continue
              }
              if (lastDeviceId) {
                this._addDeviceId(unflattened, lastDeviceId, device)
              }
            }
            this.lastUserMediaConstraints = unflattened
          } catch (e) {
          }
        }
      }
    })
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
