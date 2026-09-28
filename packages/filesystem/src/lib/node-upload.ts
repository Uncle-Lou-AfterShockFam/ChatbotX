import { PassThrough } from "node:stream"
import { Upload } from "@aws-sdk/lib-storage"
import { uploader } from "./uploader"

export function createUpload(
  path: string,
  options?: { contentType?: string },
): { stream: PassThrough; done: Promise<void> } {
  const stream = new PassThrough()
  const upload = new Upload({
    client: uploader.client,
    params: {
      Bucket: uploader.bucketName,
      Key: path,
      Body: stream,
      ContentType: options?.contentType,
    },
  })
  const done = upload.done().then(() => undefined)
  return { stream, done }
}
