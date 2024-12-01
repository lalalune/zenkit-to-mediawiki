import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

function sanitizeFileName(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '_');
}

function truncateFileName(name, maxLength = 100) {
  if (name.length <= maxLength) return name;
  const hash = crypto.createHash('md5').update(name).digest('hex');
  return name.slice(0, maxLength - hash.length - 1) + '_' + hash;
}

async function copyMediaFiles(sourceDir, targetDir, listName, entryName) {
  // Create the target directory structure
  const mediaDir = path.join(targetDir, 'Media', sanitizeFileName(listName));
  fs.mkdirSync(mediaDir, { recursive: true });

  // Construct the source path for attachments - using exact path structure
  const attachmentsPath = path.join(sourceDir, listName, 'Files', 'Items', entryName, 'Attachments');

  if (fs.existsSync(attachmentsPath)) {
    try {
      const files = fs.readdirSync(attachmentsPath);
      const copiedFiles = [];

      for (const file of files) {
        const sourcePath = path.join(attachmentsPath, file);
        const targetPath = path.join(mediaDir, file); // Keep original filename for media files

        // Only copy if source is a file (not a directory)
        if (fs.statSync(sourcePath).isFile()) {
          fs.copyFileSync(sourcePath, targetPath);
          copiedFiles.push(file);
          console.log(`Copied file: ${file} for ${listName}/${entryName}`);
        }
      }

      return copiedFiles;
    } catch (error) {
      console.error(`Error copying files for ${listName}/${entryName}:`, error);
      return [];
    }
  }
  return [];
}

async function transformZenkitToMediaWikiFiles(zenkitJson, outputDir, filesRootDir, eraseExisting = false) {
  // If eraseExisting is true, delete all existing files and directories
  if (eraseExisting && fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true });
  }

  // Create base directories
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'Media'), { recursive: true });

  // Create mapping of entry UUIDs to page names
  const entryUuidToPageNameMap = {};
  
  // Process each list in the workspace
  if (!Array.isArray(zenkitJson.lists)) {
    console.error('No lists array found in workspace JSON');
    return;
  }

  for (const list of zenkitJson.lists) {
    if (!list.list || !Array.isArray(list.elements)) continue;

    const listName = list.list.name;
    console.log(`Processing list: ${listName}`);

    // First pass: Build UUID to page name mapping
    if (Array.isArray(list.entries)) {
      for (const entry of list.entries) {
        const entryUuid = entry.uuid;
        const pageName = `${listName}/${entry.displayString}`;
        entryUuidToPageNameMap[entryUuid] = pageName;
      }
    }

    // Second pass: Generate content and copy files
    if (Array.isArray(list.entries)) {
      for (const entry of list.entries) {
        const sanitizedEntryName = sanitizeFileName(entry.displayString);
        const truncatedEntryName = truncateFileName(sanitizedEntryName);
        
        // Copy media files
        const copiedFiles = await copyMediaFiles(filesRootDir, outputDir, listName, entry.displayString);
        
        // Build page content
        let pageContent = `[[Category:${listName}]]\n\n`;
        
        // Process each field
        for (const element of list.elements) {
          const elementId = element.uuid;
          const elementName = element.name;
          let elementValue = '';

          // Handle different element types
          switch (element.elementcategory) {
            case 1: // Text
              elementValue = entry[elementId + '_text'] || '';
              break;
            case 2: // Number
              elementValue = entry[elementId + '_number']?.toString() || '';
              break;
            case 4: // Date
              elementValue = entry[elementId + '_date'] ? 
                new Date(entry[elementId + '_date']).toDateString() : '';
              break;
            case 6: // Categories
              elementValue = entry[elementId + '_categories']?.map(cat => cat.name).join(', ') || '';
              break;
            case 14: // Persons
              elementValue = entry[elementId + '_persons']?.map(person => person.displayString).join(', ') || '';
              break;
            case 16: // References
              const references = entry[elementId + '_references'] || [];
              elementValue = references
                .map(refUuid => entryUuidToPageNameMap[refUuid] ? 
                  `[[${entryUuidToPageNameMap[refUuid]}]]` : '')
                .filter(ref => ref)
                .join(', ');
              break;
          }

          if (elementValue) {
            pageContent += `\n== ${elementName} ==\n${elementValue}\n`;
          }
        }

        // Add media files to page content
        if (copiedFiles.length > 0) {
          pageContent += '\n== Media ==\n';
          for (const file of copiedFiles) {
            pageContent += `[[File:${listName}/${file}]]\n`;
          }
        }

        // Write page content to file
        if (pageContent.trim() !== `[[Category:${listName}]]`) {
          const listDir = path.join(outputDir, sanitizeFileName(listName));
          fs.mkdirSync(listDir, { recursive: true });
          const pageFile = path.join(listDir, `${truncatedEntryName}.txt`);
          fs.writeFileSync(pageFile, pageContent);
          console.log(`Created page: ${listName}/${truncatedEntryName}.txt`);
        }
      }
    }
  }

  console.log('Transformation completed successfully');
}

// Set up file paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Export the function for use in other modules
export { transformZenkitToMediaWikiFiles };

// If running directly, process command line arguments
if (import.meta.url === `file://${__filename}`) {
  const zenkitJson = JSON.parse(fs.readFileSync(process.argv[2] || './Guide_to_Emergence_1.0_Prototype.json', 'utf8'));
  const outputDir = process.argv[3] || path.join(__dirname, './mediawiki-pages');
  const filesRootDir = process.argv[4] || path.join(__dirname, './lists');
  const eraseExisting = process.argv.includes('--erase=true');

  transformZenkitToMediaWikiFiles(zenkitJson, outputDir, filesRootDir, eraseExisting)
    .catch(error => console.error('Error during conversion:', error));
}