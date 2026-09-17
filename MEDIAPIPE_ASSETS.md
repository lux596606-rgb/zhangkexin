# MediaPipe runtime assets

The files under `public/mediapipe/` are served from the same origin as the
birthday site so gesture recognition does not depend on a third-party CDN at
runtime.

- `wasm/`: copied from npm package `@mediapipe/tasks-vision@1.0.1`.
- `gesture_recognizer.task`: Google MediaPipe Gesture Recognizer float16 model,
  version 1. The binary was downloaded from the official MediaPipe model
  registry and is identified by SHA-256:
  `97952348CF6A6A4915C2EA1496B4B37EBABC50CBBF80571435643C455F2B0482`.

MediaPipe and its official samples are distributed under the Apache License
2.0. A copy of that license is stored in `public/mediapipe/LICENSE.txt`. The
upstream project is google-ai-edge/mediapipe and the model is the standard
Gesture Recognizer float16 v1 asset documented by its web samples.
