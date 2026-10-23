// تولید migrations/0001_initial.sql از functions/_lib/schema.js (منبع واحد اسکیما)
import { writeFileSync, mkdirSync } from 'node:fs';
import { SCHEMA } from '../functions/_lib/schema.js';
mkdirSync(new URL('../migrations/', import.meta.url), { recursive: true });
writeFileSync(new URL('../migrations/0001_initial.sql', import.meta.url),
  '-- MAMAX initial schema (اجرای دستی اختیاری؛ پنل در اولین اجرا خودش این جدول‌ها را می‌سازد)\n' + SCHEMA.map((s) => s + ';').join('\n\n') + '\n');
console.log('migrations/0001_initial.sql written');
