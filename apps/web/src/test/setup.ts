import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no scrolling/layout engine; navigation behaviour is tested separately.
vi.stubGlobal('scrollTo', vi.fn());

afterEach(cleanup);
