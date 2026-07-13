import type { drive_v3 } from 'googleapis'
import { prisma } from '../../config/prisma.js'

interface MigrationFileResult {
  targetFileId: string
  checksum: string
}

export async function migrateFile(
  sourceDrive: drive_v3.Drive,
  targetDrive: drive_v3.Drive,
  sourceFileId: string,
  targetFolderId: string,
  fileName: string,
  mimeType: string,
  migrationId: string,
  itemId: string,
): Promise<MigrationFileResult> {
  return prisma.$transaction(async (tx) => {
    // Lock migration item
    await tx.migrationItem.updateMany({
      where: { id: itemId, migrationId, status: 'pending' },
      data: { status: 'transferring' }
    })

    try {
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

      const targetFileId = uploaded.data.id
      if (!targetFileId) throw new Error('Google Drive did not return a file ID after upload.')

      // Calculate real checksum
      const response = await sourceDrive.files.get(
        { fileId: sourceFileId, alt: 'media' },
        { responseType: 'stream' }
      )
      const stream = response.data as unknown as Readable
      const hash = createHash('sha256')
      for await (const chunk of stream) {
        hash.update(chunk)
      }
      const checksum = `sha256:${hash.digest('hex')}`

      // Update migration item
      await tx.migrationItem.update({
        where: { id: itemId },
        data: {
          status: 'completed',
          targetFileId,
          checksum
        }
      })

      return { targetFileId, checksum }
    } catch (error) {
      // Rollback: mark as failed
      await tx.migrationItem.update({
        where: { id: itemId },
        data: {
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Migration failed'
        }
      })
      throw error
    }
  })
}
