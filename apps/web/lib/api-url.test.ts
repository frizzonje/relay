import { afterEach, describe, expect, it } from 'vitest';
import { apiUrl } from './api-url';

describe('apiUrl', () => {
  const was = process.env.NEXT_PUBLIC_API_URL;
  afterEach(() => {
    process.env.NEXT_PUBLIC_API_URL = was;
  });

  it('без переменной — путь на своём origin', () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(apiUrl('/api/config')).toBe('/api/config');
  });

  it('с переменной — api на другом origin', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test';
    expect(apiUrl('/api/config')).toBe('https://api.example.test/api/config');
  });
});
