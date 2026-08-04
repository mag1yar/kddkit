// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Prose } from '../src/web/components/Prose';

// Картинка в теле стоит относительной ссылкой /api/files/7. <img> идёт в сеть сам, мимо
// req(): без ?project он спросил бы у сервера ЧУЖУЮ доску, а на выставленном наружу
// сервере без ?token получил бы 401 — то есть битую картинку у человека.
beforeEach(() => {
  window.history.replaceState({}, '', '/?project=deadbeef&token=s3cret');
});

// vitest здесь без globals:true — автo-cleanup RTL себя не находит, как и в соседних
// *.test.tsx, гасим DOM между тестами вручную.
afterEach(() => { cleanup(); });

describe('Prose', () => {
  it('дописывает project и token к ссылке на вложение', () => {
    render(<Prose>{'![кнопка](/api/files/7)'}</Prose>);
    const img = screen.getByAltText('кнопка') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/files/7?project=deadbeef&token=s3cret');
  });

  it('внешнюю картинку не трогает', () => {
    render(<Prose>{'![внешняя](https://example.com/a.png)'}</Prose>);
    const img = screen.getByAltText('внешняя') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://example.com/a.png');
  });

  // I3: ссылка на не-картиночное вложение — тот же /api/files/<id>, что и у img выше, и та же
  // дыра без ?project/?token: чужая доска или 401 на выставленном наружу сервере.
  it('дописывает project и token к ссылке на не-картиночное вложение', () => {
    render(<Prose>{'[report.pdf](/api/files/8)'}</Prose>);
    const a = screen.getByText('report.pdf') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/api/files/8?project=deadbeef&token=s3cret');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noreferrer');
  });

  it('внешнюю ссылку не трогает', () => {
    render(<Prose>{'[внешняя](https://example.com/a)'}</Prose>);
    const a = screen.getByText('внешняя') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com/a');
  });
});
