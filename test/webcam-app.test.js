import { FakeMediaStream, FakeMediaTrack, LocalStorageMock, testForEvent, testForNoEvent } from '@gurupras/test-helpers' // Must be first so that global.MediaStream is updated
import ProxyMediaStream from '@gurupras/proxy-media-stream'
import deepmerge from 'deepmerge'

import WebcamApp from '../index'

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
describe('WebcamApp', () => {
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

  describe('Watch', () => {
    async function waitForWatch (obj, field, setter) {
      const promise = testForEvent(obj, 'watch')
      setter()
      await expect(promise).toResolve()
      const { path } = await promise
      expect(path).toEqual(field)
    }
    test('Changes to \'lastUserMediaConstraints\' are saved in localStorage', async () => {
      let constraints = {}
      await waitForWatch(app, 'lastUserMediaConstraints', () => { app.lastUserMediaConstraints = constraints })
      expect(localStorage.getItem(lastUserMediaConstraintsKey)).toEqual(JSON.stringify(constraints))

      constraints = { audio: true, video: false }
      await waitForWatch(app, 'lastUserMediaConstraints', () => { app.lastUserMediaConstraints = constraints })
      expect(localStorage.getItem(lastUserMediaConstraintsKey)).toEqual(JSON.stringify(constraints))

      constraints = { audio: true, video: true }
      await waitForWatch(app, 'lastUserMediaConstraints', () => { app.lastUserMediaConstraints = constraints })
      expect(localStorage.getItem(lastUserMediaConstraintsKey)).toEqual(JSON.stringify(constraints))
    })

    test('Changes to \'selfWebcamStream\' are emitted via \'webcam-stream\' event', async () => {
      const stream = new FakeMediaStream(null, { numAudioTracks: 2, numVideoTracks: 2 })
      const promise = testForEvent(app, 'webcam-stream')
      await waitForWatch(app, 'selfWebcamStream', () => { app.selfWebcamStream = stream })
      await expect(promise).toResolve()
    })

    test('If neither selfVideoStream nor selfAudioStream are present, selfWebcamStream is removed', async () => {
      const videoStream = new FakeMediaStream(null, { numVideoTracks: 2 })
      const audioStream = new FakeMediaStream(null, { numAudioTracks: 2 })
      const webcamStream = new FakeMediaStream([...videoStream.getTracks(), ...audioStream.getTracks()])
      let promise

      app.selfVideoStream = videoStream
      app.selfAudioStream = audioStream
      promise = testForEvent(app, 'webcam-stream')
      app.selfWebcamStream = webcamStream
      await expect(promise).resolves.toEqual({ newStream: webcamStream, oldStream: undefined })

      promise = testForEvent(app, 'webcam-stream')
      app.selfVideoStream = undefined
      app.selfAudioStream = undefined
      await expect(promise).resolves.toEqual({ newStream: undefined, oldStream: webcamStream })
    })
    test('If either selfVideoStream or selfAudioStream are present, selfWebcamStream is preserved', async () => {
      const videoStream = new FakeMediaStream(null, { numVideoTracks: 2 })
      const audioStream = new FakeMediaStream(null, { numAudioTracks: 2 })
      const webcamStream = new FakeMediaStream([...videoStream.getTracks(), ...audioStream.getTracks()])
      let promise

      app.selfVideoStream = videoStream
      app.selfAudioStream = audioStream
      promise = testForEvent(app, 'webcam-stream')
      app.selfWebcamStream = webcamStream
      await expect(promise).resolves.toEqual({ newStream: webcamStream, oldStream: undefined })

      promise = testForNoEvent(app, 'webcam-stream')
      await expect(promise).toResolve()

      promise = testForNoEvent(app, 'webcam-stream')
      app.selfVideoStream = undefined
      await expect(promise).toResolve()
      app.selfVideoStream = videoStream

      promise = testForNoEvent(app, 'webcam-stream')
      app.selfAudioStream = undefined
      await expect(promise).toResolve()
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
      // TODO: Write explicit tests for updateStream
    })
  })
})
