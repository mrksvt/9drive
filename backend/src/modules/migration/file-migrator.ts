import type { drive_v3 } from 'googleapis'

export async function migrateFile(
  sourceDrive: drive_v3.Drive,
  targetDrive: drive_v3.Drive,
  sourceFileId: string,
  targetFolderId: string,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const response = await sourceDrive.files.get(
    { fileId: sourceFileId, alt: 'media' },
    { responseType: 'stream' },
  )

  const stream = response.data as unknown as NodeJS.ReadableStream

  const uploaded = await targetDrive.files.create({
    requestBody: { name: fileName, parents: [targetFolderId] },
    media: { mimeType, body: stream },
    fields: 'id',
  })

  const fileId = uploaded.data.id
  if (!fileId) throw new Error('Google Drive did not return a file ID after upload.')
  return fileId
}
