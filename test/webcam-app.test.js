import { watch, nextTick, toRefs } from 'vue'
import { FakeMediaStream, FakeMediaTrack, LocalStorageMock, testForEvent } from '@gurupras/test-helpers' // Must be first so that global.MediaStream is updated
import ProxyMediaStream from '@gurupras/proxy-media-stream'
import deepmerge from 'deepmerge'

import WebcamApp from '../index'

function waitForWatch (prop, executor, opts) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('waitForWatch timed out')), 100)
    const unwatch = watch(prop, (v, o) => {
      unwatch()
      clearTimeout(timeout)
      nextTick(() => resolve([v, o]))
    }, opts)
    executor()
  })
}

function mockGetUserMedia () {
  global.navigator.mediaDevices.getUserMedia = jest.fn().mockImplementation(async ({ audio, video }) => {
    const stream = new FakeMediaStream()
    if (audio) {
      stream.addTrack(new FakeMediaTrack({ kind: 'audio' }))
    }
    if (video) {
      stream.addTrack(new FakeMediaTrack({ kind: 'video' }))
    }
    return stream
  })
}

let lastUserMediaConstraintsKey
const constraintsUpdateEvent = 'constraints-updated'
describe('WebcamApp', () => {
  /** @type {WebcamApp.default} */
  let app
  beforeEach(async () => {
    global.localStorage = new LocalStorageMock()
    global.MediaStream = FakeMediaStream
    Object.assign(navigator, {
      permissions: {
      },
      mediaDevices: {
      }
    })
    app = new WebcamApp()
    lastUserMediaConstraintsKey = app.lastUserMediaConstraintsKey
    app.lastUserMediaConstraints = app.defaultUserMediaConstraints() // TODO: Figure out if this should be here since we should be using new LocalStorageMocks each time
  })

  test('No duplicates when LocalStorage contains prior constraints', async () => {
    const expected = JSON.parse(localStorage[lastUserMediaConstraintsKey])
    expect(app.lastUserMediaConstraints).toEqual(expected)
    // When we create a new WebcamApp, the resulting constraints-merge should not create duplicates
    app = new WebcamApp()
    expect(app.lastUserMediaConstraints).toEqual(expected)
  })

  test('Different order of optional constraints don\'t cause duplicates', async () => {
    const { optional } = toRefs(app.lastUserMediaConstraints.audio)
    const sourceIDConstraintIndex = optional.value.findIndex(x => x.sourceId)
    const sourceIDConstraint = optional.value[sourceIDConstraintIndex]

    // TODO: We should be testing a custom set of constraints that is known to have more than 1 value
    await expect(waitForWatch(() => app.lastUserMediaConstraints, () => { optional.value.splice(sourceIDConstraintIndex, 1) }, { deep: true })).toResolve()
    await expect(waitForWatch(() => app.lastUserMediaConstraints, () => { optional.value.splice(sourceIDConstraintIndex - 1, 0, sourceIDConstraint) }, { deep: true })).toResolve()
    // Modify the value of this constraint
    await expect(waitForWatch(() => app.lastUserMediaConstraints, () => { sourceIDConstraint.sourceId = 'dummy' }, { deep: true })).toResolve()

    // Now, create a new instance of WebcamApp which will use the default order of optional constraints
    // And ensure that there is only one sourceId constraint and that its value is 'dummy'
    app = new WebcamApp()
    {
      const { lastUserMediaConstraints: { audio: { optional } } } = app
      const sourceIDConstraints = optional.filter(x => x.sourceId)
      expect(sourceIDConstraints).toBeArrayOfSize(1)
      const [sourceIDConstraint] = sourceIDConstraints
      expect(sourceIDConstraint.sourceId).toEqual('dummy')
    }
  })

  describe('Watch', () => {
    test('Changes to \'lastUserMediaConstraints\' are saved in localStorage', async () => {
      let constraints = {}
      await waitForWatch(() => app.lastUserMediaConstraints, () => { app.lastUserMediaConstraints = constraints })
      expect(localStorage.getItem(lastUserMediaConstraintsKey)).toEqual(JSON.stringify(constraints))

      constraints = { audio: true, video: false }
      await waitForWatch(() => app.lastUserMediaConstraints, () => { app.lastUserMediaConstraints = constraints })
      expect(localStorage.getItem(lastUserMediaConstraintsKey)).toEqual(JSON.stringify(constraints))

      constraints = { audio: true, video: true }
      await waitForWatch(() => app.lastUserMediaConstraints, () => { app.lastUserMediaConstraints = constraints })
      expect(localStorage.getItem(lastUserMediaConstraintsKey)).toEqual(JSON.stringify(constraints))
    })
    test('Deep changes to \'lastUserMediaConstraints\' are saved in localStorage', async () => {
      // Alter this constraint a little
      mockGetUserMedia()
      await waitForWatch(() => app.lastUserMediaConstraints, async () => { await app.switchDevice('videoInput', 'dummy') }, { deep: true })
      const expected = JSON.stringify(app.lastUserMediaConstraints)
      expect(localStorage.getItem(lastUserMediaConstraintsKey)).toEqual(expected)
    })

    test('Changes to \'selfWebcamStream\' trigger the watch', async () => {
      const stream = new FakeMediaStream({ numAudioTracks: 2, numVideoTracks: 2 })
      await expect(waitForWatch(() => app.selfWebcamStream, () => { app.selfWebcamStream = stream })).toResolve()
    })

    test('If neither selfVideoStream nor selfAudioStream are present, selfWebcamStream is removed', async () => {
      const videoStream = new FakeMediaStream({ numVideoTracks: 2 })
      const audioStream = new FakeMediaStream({ numAudioTracks: 2 })
      const webcamStream = new FakeMediaStream([...videoStream.getTracks(), ...audioStream.getTracks()])
      let promise

      app.selfVideoStream = videoStream
      app.selfAudioStream = audioStream
      promise = waitForWatch(() => app.selfWebcamStream, () => { app.selfWebcamStream = webcamStream })
      app.selfWebcamStream = webcamStream
      await expect(promise).resolves.toEqual([webcamStream, undefined])

      promise = waitForWatch(() => app.selfWebcamStream, () => {
        app.selfVideoStream = undefined
        app.selfAudioStream = undefined
      })
      await expect(promise).resolves.toEqual([undefined, webcamStream])
    })
    test('If either selfVideoStream or selfAudioStream are present, selfWebcamStream is preserved', async () => {
      const videoStream = new FakeMediaStream(null, { numVideoTracks: 2 })
      const audioStream = new FakeMediaStream(null, { numAudioTracks: 2 })
      const webcamStream = new FakeMediaStream([...videoStream.getTracks(), ...audioStream.getTracks()])

      app.selfVideoStream = videoStream
      app.selfAudioStream = audioStream
      await expect(waitForWatch(() => app.selfWebcamStream, () => { app.selfWebcamStream = webcamStream })).resolves.toEqual([webcamStream, undefined])

      await waitForWatch(() => app.selfVideoStream, () => { app.selfVideoStream = undefined })
      await expect(app.selfWebcamStream).toEqual(webcamStream)
      app.selfVideoStream = videoStream

      await waitForWatch(() => app.selfAudioStream, () => { app.selfAudioStream = undefined })
      await expect(app.selfWebcamStream).toEqual(webcamStream)
    })
  })

  describe('API', () => {
    describe('setDefaultUserMediaConstraints', () => {
      let defaults
      beforeEach(() => {
        defaults = {
          video: 'dummy',
          audio: { optional: { source: 'dummy' } }
        }
      })
      test('Properly overrides defaultUserMediaConstraints', async () => {
        expect(() => app.setDefaultUserMediaConstraints(defaults)).not.toThrow()
        expect(app.defaultUserMediaConstraints()).toEqual(defaults)
      })
      test('Changing default afterwards does not change returned value', async () => {
        app.setDefaultUserMediaConstraints(defaults)
        const copy = deepmerge({}, defaults)
        defaults.video = true
        expect(app.defaultUserMediaConstraints()).toEqual(copy)
      })
      test.each([
        ['null', null],
        ['undefined', undefined],
        ['\'\'', '']
      ])('Setting it to falsey value (%s) works as expected', async (label, value) => {
        app.setDefaultUserMediaConstraints(value)
        expect(app.defaultUserMediaConstraints()).toBe(value)
      })
    })
    describe('checkPermissions', () => {
      test('Properly sets (mic|camera)PermissionState on success of navigator.permissions.query', async () => {
        const result = { state: 'granted' }
        global.navigator.permissions.query = jest.fn().mockResolvedValue(result)
        await expect(app.checkPermissions()).toResolve()
        await expect(global.navigator.permissions.query).toHaveBeenCalledTimes(2)
        // First, checks mic, then camera
        await expect(global.navigator.permissions.query).toHaveBeenNthCalledWith(1, { name: 'microphone' })
        await expect(global.navigator.permissions.query).toHaveBeenNthCalledWith(2, { name: 'camera' })
        expect(app.micPermissionState).toEqual(result.state)
        expect(app.cameraPermissionState).toEqual(result.state)
      })

      test('Properly sets (mic|camera)PermissionState=denied on failure of navigator.permissions.query', async () => {
        const result = 'denied'
        global.navigator.permissions.query = jest.fn().mockRejectedValue(new Error('failed'))
        await expect(app.checkPermissions()).toResolve()
        await expect(global.navigator.permissions.query).toHaveBeenCalledTimes(2)
        // First, checks mic, then camera
        await expect(global.navigator.permissions.query).toHaveBeenNthCalledWith(1, { name: 'microphone' })
        await expect(global.navigator.permissions.query).toHaveBeenNthCalledWith(2, { name: 'camera' })
        expect(app.micPermissionState).toEqual(result)
        expect(app.cameraPermissionState).toEqual(result)

        let idx = 0
        global.navigator.permissions.query = jest.fn().mockImplementation(async () => {
          idx++
          if (idx % 2 === 0) {
            return { state: 'granted' }
          }
          throw new Error('failed')
        })
        await expect(app.checkPermissions()).toResolve()
        expect(app.micPermissionState).toEqual('denied')
        expect(app.cameraPermissionState).toEqual('granted')
      })
    })

    describe('handleError', () => {
      const errors = ['AbortError', 'NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError', 'TypeError']
      const deviceParams = [
        ['webcam', 'video', 'cameraPermissionState'],
        ['microphone', 'audio', 'micPermissionState']
      ]
      const combinations = []
      for (const err of errors) {
        for (const dparams of deviceParams) {
          combinations.push([{ name: err }, ...dparams])
        }
      }
      test.each(combinations)('Throws error event on %s for %s', async (err, device, userConstraintsKey, statePropertyName) => {
        expect(() => app.handleError(err, device, userConstraintsKey, statePropertyName)).toThrow()
      })
      test.each(deviceParams)('NotAllowedError properly updates %s permission state to denied', async (device, userConstraintsKey, statePropertyName) => {
        expect(() => app.handleError({ name: 'NotAllowedError' }, device, userConstraintsKey, statePropertyName)).toThrow()
        expect(app[statePropertyName]).toEqual('denied')
      })
      test.each(deviceParams)('OverConstrainedError resets %s constraints to defaults', async (device, userConstraintsKey, statePropertyName) => {
        app.lastUserMediaConstraints[userConstraintsKey] = 'bad'
        expect(() => app.handleError({ name: 'OverconstrainedError' }, device, userConstraintsKey, statePropertyName)).toThrow()
        expect(app.lastUserMediaConstraints).toEqual(app.defaultUserMediaConstraints())
      })
    })

    describe('requestCamera', () => {
      beforeEach(() => {
        mockGetUserMedia()
      })
      test('Gets camera stream even if lastUserMediaConstraints.video is falsey', async () => {
        app.lastUserMediaConstraints = {
          video: false,
          audio: false
        }
        await expect(app.requestCamera()).toResolve()
        expect(app.selfVideoStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfAudioStream).toBe(null)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(1)
      })
      test('Only get camera stream even if lastUserMediaConstraints.audio == true', async () => {
        app.lastUserMediaConstraints = {
          video: false,
          audio: true
        }
        await expect(app.requestCamera()).toResolve()
        expect(app.selfVideoStream.getTracks()).toBeArrayOfSize(1)
        // Will only request microphone if selfAudioStream is already set
        expect(app.selfAudioStream).toBe(null)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(1)
      })
      test('Get both camera and mic streams if selfAudioStream has at least one audio track', async () => {
        app.lastUserMediaConstraints = {
          video: false,
          audio: true
        }
        app.selfAudioStream = new FakeMediaStream(null, { numAudioTracks: 1 })
        await expect(app.requestCamera()).toResolve()
        expect(app.selfVideoStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfAudioStream).toBeTruthy()
        expect(app.selfAudioStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(2)
      })
      test('Turns off resulting audio track if audio track was previously paused', async () => {
        app.lastUserMediaConstraints = {
          video: false,
          audio: true
        }
        app.selfAudioStream = new FakeMediaStream(null, { numAudioTracks: 1 })
        // Pause the track
        app.selfAudioTrackEnabled = false
        await expect(app.requestCamera()).toResolve()
        expect(app.selfVideoStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfAudioStream).toBeTruthy()
        expect(app.selfAudioStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(2)
        expect(app.selfAudioStream.getTracks()[0].enabled).toBeFalse()
      })
      describe('Error handling', () => {
        beforeEach(() => {
        })
        test('Throws error on failure', async () => {
          navigator.mediaDevices.getUserMedia = jest.fn().mockRejectedValue({
            name: 'unknown',
            message: 'dummy'
          })
          await expect(app.requestCamera()).toReject()
          expect(app.selfWebcamStream).toBe(undefined)
          // Ensure that cameraPermissionState did not change
          expect(app.cameraPermissionState).toBe('prompt')
        })

        test('Sets cameraPermissionState=denied when it fails with NotAllowedError', async () => {
          navigator.mediaDevices.getUserMedia = jest.fn().mockRejectedValue({
            name: 'NotAllowedError',
            message: 'dummy'
          })
          await expect(app.requestCamera()).toReject()
          expect(app.selfWebcamStream).toBe(undefined)
          expect(app.cameraPermissionState).toBe('denied')
        })
      })
    })

    describe('requestMicrophone', () => {
      beforeEach(() => {
        mockGetUserMedia()
      })
      test('Gets microphone stream even if lastUserMediaConstraints.audio is falsey', async () => {
        app.lastUserMediaConstraints = {
          video: false,
          audio: false
        }
        await expect(app.requestMicrophone()).toResolve()
        expect(app.selfVideoStream).toBe(null)
        expect(app.selfAudioStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(1)
      })
      test('Only get microphone stream even if lastUserMediaConstraints.video == true', async () => {
        app.lastUserMediaConstraints = {
          video: true,
          audio: false
        }
        await expect(app.requestMicrophone()).toResolve()
        // Will only request camera if selfVideoStream is already set
        expect(app.selfVideoStream).toBe(null)
        expect(app.selfAudioStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(1)
      })
      test('Get both camera and mic streams if selfVideoStream has at least one video track', async () => {
        app.lastUserMediaConstraints = {
          video: true,
          audio: false
        }
        app.selfVideoStream = new FakeMediaStream(null, { numVideoTracks: 1 })
        await expect(app.requestMicrophone()).toResolve()
        expect(app.selfVideoStream).toBeTruthy()
        expect(app.selfVideoStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfAudioStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(2)
      })
      test('Turns off resulting video track if video track was previously paused', async () => {
        app.lastUserMediaConstraints = {
          video: true,
          audio: false
        }
        app.selfVideoStream = new FakeMediaStream(null, { numVideoTracks: 1 })
        // Pause the track
        app.selfVideoTrackEnabled = false
        await expect(app.requestMicrophone()).toResolve()
        expect(app.selfVideoStream).toBeTruthy()
        expect(app.selfVideoStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfAudioStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(2)
        expect(app.selfVideoStream.getTracks()[0].enabled).toBeFalse()
      })
      describe('Error handling', () => {
        beforeEach(() => {
          console.error = () => { }
        })
        test('Throws error on failure', async () => {
          navigator.mediaDevices.getUserMedia = jest.fn().mockRejectedValue({
            name: 'unknown',
            message: 'dummy'
          })
          await expect(app.requestMicrophone()).toReject()
          expect(app.selfWebcamStream).toBe(undefined)
          // Ensure that cameraPermissionState did not change
          expect(app.micPermissionState).toBe('prompt')
        })

        test('Sets micPermissionState=denied when it fails with NotAllowedError', async () => {
          navigator.mediaDevices.getUserMedia = jest.fn().mockRejectedValue({
            name: 'NotAllowedError',
            message: 'dummy'
          })
          await expect(app.requestMicrophone()).toReject()
          expect(app.selfWebcamStream).toBe(undefined)
          expect(app.micPermissionState).toBe('denied')
        })
      })
    })

    describe('getSelectedDeviceId', () => {
      test('Return false if lastUserMediaConstraints[device] == true', async () => {
        app.lastUserMediaConstraints = {
          video: true,
          audio: true
        }
        expect(app.getSelectedDeviceId('video')).toEqual(null)
      })
      test('Return true if present via exact deviceId', async () => {
        app.lastUserMediaConstraints = {
          video: {
            deviceId: {
              exact: 'device-1'
            }
          },
          audio: true
        }
        expect(app.getSelectedDeviceId('video')).toEqual('device-1')
      })

      test('Works even if device is specified as an optional constraint', async () => {
        app.lastUserMediaConstraints = {
          video: {
            optional: [
              { minFrameRate: 30 },
              { maxFrameRate: 30 },
              { sourceId: 'device-1' },
              { minWidth: 320 }
            ]
          },
          audio: true
        }
        expect(app.getSelectedDeviceId('video')).toEqual('device-1')
      })
    })
    describe('isSelected', () => {
      test('Return false if lastUserMediaConstraints[device] == true', async () => {
        app.lastUserMediaConstraints = {
          video: true,
          audio: true
        }
        expect(app.isSelected('video', 'device-1')).toBe(false)
      })
      test('Return true if present', async () => {
        app.lastUserMediaConstraints = {
          video: {
            deviceId: {
              exact: 'device-1'
            }
          },
          audio: true
        }
        expect(app.isSelected('video', 'device-2')).toBe(false)
        expect(app.isSelected('video', 'device-1')).toBe(true)
      })
      test('Works even if device is specified as an optional constraint', async () => {
        app.lastUserMediaConstraints = {
          video: {
            optional: [
              { minFrameRate: 30 },
              { maxFrameRate: 30 },
              { sourceId: 'device-1' },
              { minWidth: 320 }
            ]
          },
          audio: true
        }
        expect(app.isSelected('video', 'device-2')).toBe(false)
        expect(app.isSelected('video', 'device-1')).toBe(true)
      })
    })

    describe('switchDevice', () => {
      let videoStream
      let audioStream
      let stream
      let audioSource
      let videoSource
      beforeEach(() => {
        mockGetUserMedia()
        videoSource = app.lastUserMediaConstraints.video.optional.find(x => x.sourceId)
        audioSource = app.lastUserMediaConstraints.audio.optional.find(x => x.sourceId)
        videoSource.sourceId = 'vd-1'
        audioSource.sourceId = 'ad-1'

        stream = new FakeMediaStream(null, { numVideoTracks: 1, numAudioTracks: 1 })
        const { videoStream: vStream, audioStream: aStream } = ProxyMediaStream.splitStream(stream)
        videoStream = vStream
        audioStream = aStream
        app.selfVideoStream = videoStream
        app.selfAudioStream = audioStream
        app.selfWebcamStream = stream
      })

      test('Throws error on bad \'type\'', async () => {
        await expect(app.switchDevice('bad', 'dummy')).toReject()
      })
      test('Changing either video/audio constraint preserves the other when making new getUserMedia call', async () => {
        // Change videoInput and verify that audio properties were preserved
        const oldConstraints = deepmerge({}, app.lastUserMediaConstraints)
        const newVideoDevice = 'vd-2'
        await app.switchDevice('videoInput', newVideoDevice)
        // await expect().toResolve()
        let expectedConstraints = deepmerge({}, oldConstraints)
        expectedConstraints.video.optional.find(x => x.sourceId).sourceId = newVideoDevice
        await expect(global.navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expectedConstraints)
        await expect(app.selfVideoStream).not.toEqual(videoStream)

        // Now, change audioInput and verify that video properties were preserved
        const newAudioDevice = 'ad-2'
        await expect(app.switchDevice('audioInput', newAudioDevice)).toResolve()
        expectedConstraints = deepmerge({}, app.lastUserMediaConstraints)
        expectedConstraints.audio.optional.find(x => x.sourceId).sourceId = newAudioDevice
        await expect(global.navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expectedConstraints)
        await expect(app.selfAudioStream).not.toEqual(audioStream)
      })
    })

    describe('stopCamera', () => {
      test('Stops videoStream', async () => {
        const stream = new FakeMediaStream(null, { numVideoTracks: 1, numAudioTracks: 1 })
        const { videoStream, audioStream } = ProxyMediaStream.splitStream(stream)
        app.selfVideoStream = videoStream
        app.selfAudioStream = audioStream
        app.selfWebcamStream = stream

        const track = videoStream.getTracks()[0]
        const promise = testForEvent(track, 'ended', { on: 'addEventListener', off: 'removeEventListener' })
        app.stopCamera()
        await expect(promise).toResolve()
        expect(app.selfVideoStream).toBe(null)
        expect(app.selfAudioStream).toEqual(audioStream)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfWebcamStream.getAudioTracks()).toBeArrayOfSize(1)
      })
    })

    describe('stopMicrophone', () => {
      test('Stops audioStream', async () => {
        const stream = new FakeMediaStream(null, { numVideoTracks: 1, numAudioTracks: 1 })
        const { videoStream, audioStream } = ProxyMediaStream.splitStream(stream)
        app.selfVideoStream = videoStream
        app.selfAudioStream = audioStream
        app.selfWebcamStream = stream

        const track = audioStream.getTracks()[0]
        const promise = testForEvent(track, 'ended', { on: 'addEventListener', off: 'removeEventListener' })
        app.stopMicrophone()
        await expect(promise).toResolve()
        expect(app.selfVideoStream).toEqual(videoStream)
        expect(app.selfAudioStream).toBe(null)
        expect(app.selfWebcamStream.getTracks()).toBeArrayOfSize(1)
        expect(app.selfWebcamStream.getVideoTracks()).toBeArrayOfSize(1)
      })
    })
    describe('Preserve deviceId', () => {
      let newConstraints
      beforeEach(async () => {
        mockGetUserMedia()
        const defaultConstraints = {
          video: {
            optional: [
              { minFrameRate: 30 },
              { maxFrameRate: 30 },
              { sourceId: 'video-device-1' },
              { minWidth: 320 }
            ]
          },
          audio: {
            optional: [
              { echoCancellation: true },
              { noiseSuppression: true },
              { sourceId: 'audio-device-1' },
              { autoGainControl: true },
              { googEchoCancellation: true }
            ]
          }
        }
        app.lastUserMediaConstraints = deepmerge({}, defaultConstraints)

        newConstraints = deepmerge({}, defaultConstraints)
        const videoEntry = app._getOptionalDeviceIdEntry('video', newConstraints)
        videoEntry.sourceId = 'video-device-2'
        const audioEntry = app._getOptionalDeviceIdEntry('audio', newConstraints)
        audioEntry.sourceId = 'audio-device-2'
      })

      test('Setting audio/video to false preserves deviceId (if previously specified', async () => {
        app.lastUserMediaConstraints = { audio: false, video: false }
        await nextTick()
        expect(global.localStorage.getItem(app.lastUserMediaVideoDeviceKey)).toEqual('video-device-1')
        expect(global.localStorage.getItem(app.lastUserMediaAudioDeviceKey)).toEqual('audio-device-1')
      })
      test('Setting audio/video to different device preserves latest deviceId', async () => {
        app.lastUserMediaConstraints = newConstraints
        await nextTick()
        expect(global.localStorage.getItem(app.lastUserMediaVideoDeviceKey)).toEqual('video-device-2')
        expect(global.localStorage.getItem(app.lastUserMediaAudioDeviceKey)).toEqual('audio-device-2')
        app.lastUserMediaConstraints = { audio: false, video: false }
        await nextTick()
        expect(global.localStorage.getItem(app.lastUserMediaVideoDeviceKey)).toEqual('video-device-2')
        expect(global.localStorage.getItem(app.lastUserMediaAudioDeviceKey)).toEqual('audio-device-2')
      })
      test('Creating a new app restores the last used devices', async () => {
        app.lastUserMediaConstraints = newConstraints
        await nextTick()

        const newApp = new WebcamApp() // eslint-disable-line
        await nextTick()
        expect(app.getSelectedDeviceId('video')).toEqual('video-device-2')
        expect(app.getSelectedDeviceId('audio')).toEqual('audio-device-2')
      })

      test('Setting audio/video to false and requesting Mic/Camera restores last used deviceId', async () => {
        app.lastUserMediaConstraints = { audio: false, video: false }

        await nextTick()
        await app.requestCamera()
        await app.requestMicrophone()

        expect(global.localStorage.getItem(app.lastUserMediaVideoDeviceKey)).toEqual('video-device-1')
        expect(global.localStorage.getItem(app.lastUserMediaAudioDeviceKey)).toEqual('audio-device-1')
        expect(app.getSelectedDeviceId('video')).toEqual('video-device-1')
        expect(app.getSelectedDeviceId('audio')).toEqual('audio-device-1')
      })
    })

    describe('enumerate*Devices', () => {
      let devices
      beforeEach(() => {
        devices = [
          {
            deviceId: 'dummy-video-device-1',
            groupId: 'dummy-video-group-1',
            kind: 'videoinput',
            label: 'dummy video device 1'
          },
          {
            deviceId: 'dummy-video-device-2',
            groupId: 'dummy-video-group-2',
            kind: 'videoinput',
            label: 'dummy video device 2'
          },
          {
            deviceId: 'default',
            groupId: 'default',
            kind: 'videoinput',
            label: 'dummy video device 2'
          },
          {
            deviceId: 'dummy-audio-device-1',
            groupId: 'dummy-audio-group-1',
            kind: 'audioinput',
            label: 'dummy audio device 1'
          },
          {
            deviceId: 'dummy-audio-device-2',
            groupId: 'dummy-audio-group-2',
            kind: 'audioinput',
            label: 'dummy audio device 2'
          },
          {
            deviceId: 'default',
            groupId: 'default',
            kind: 'audioinput',
            label: 'dummy audio device 1'
          },
          {
            deviceId: 'dummy-audio-device-3',
            groupId: 'dummy-audio-group-3',
            kind: 'audiooutput',
            label: 'dummy audio device 3'
          },
          {
            deviceId: 'dummy-audio-device-3',
            groupId: 'dummy-audio-group-3',
            kind: 'audiooutput',
            label: 'dummy audio device 3'
          }
        ]
        global.navigator.mediaDevices.enumerateDevices = jest.fn().mockReturnValue(devices)
      })
      test('enumerateDevices with no argument returns all devices', async () => {
        await expect(app.enumerateDevices()).resolves.toIncludeSameMembers(devices)
      })
      test('enumerateDevices with only type filters all available devices by type', async () => {
        const expected = devices.filter(x => x.kind === 'videoinput')
        await expect(app.enumerateDevices('videoinput')).resolves.toIncludeSameMembers(expected)
      })
      test('enumerateDevices with type and custom device list filters device list by type', async () => {
        const customDeviceList = devices.slice(2)
        const expected = customDeviceList.filter(x => x.kind === 'videoinput')
        await expect(app.enumerateDevices('videoinput', customDeviceList)).resolves.toIncludeSameMembers(expected)
      })
      test('enumerateAudioInputDevices returns all audio input devices', async () => {
        const expected = devices.filter(x => x.kind === 'audioinput')
        await expect(app.enumerateAudioInputDevices()).resolves.toIncludeSameMembers(expected)
      })
      test('enumerateAudioOutputDevices returns all audio output devices', async () => {
        const expected = devices.filter(x => x.kind === 'audiooutput')
        await expect(app.enumerateAudioOutputDevices()).resolves.toIncludeSameMembers(expected)
      })
      test('enumerateVideoInputDevices returns all video input devices', async () => {
        const expected = devices.filter(x => x.kind === 'videoinput')
        await expect(app.enumerateVideoInputDevices()).resolves.toIncludeSameMembers(expected)
      })
    })
    // TODO: Write explicit tests for updateStream
  })
})
