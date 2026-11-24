import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactBlock, ArtifactFormat, VisualArtifact } from '../lib/visualArtifacts';
import { VisualArtifactView } from './VisualArtifactView';

afterEach(cleanup);

function artifact(format: ArtifactFormat, ...blocks: ArtifactBlock[]): VisualArtifact {
  return { version: 1, format, title: 'Catchment notebook', blocks };
}

const scene: ArtifactBlock = {
  kind: 'scene',
  nodes: [
    { label: 'Snowpack', alt: 'Mountain ridge', x: 15, y: 50,
      shapes: [{ kind: 'path', d: 'M5 90 L45 12 L95 90 Z', fill: 'cool', stroke: 'ink' }] },
    { label: 'Reservoir', alt: 'Upright tank', x: 85, y: 50,
      shapes: [{ kind: 'rect', x: 10, y: 10, width: 80, height: 80, level: true, fill: 'accent', stroke: 'none' }] },
  ],
  frames: [
    { label: 'Winter', caption: 'Snow accumulates.', values: ['Cold', '25%'], levels: [null, 0.25], flows: [] },
    { label: 'Spring', caption: 'Meltwater reaches the reservoir.', values: ['Melting', '75%'], levels: [null, 0.75],
      flows: [{ from: 0, to: 1, label: 'Runoff' }] },
  ],
};

describe('VisualArtifactView', () => {
  it('renders authored vector shapes and updates directed flows, captions, and levels on keyboard stage changes', () => {
    render(<VisualArtifactView artifact={artifact('explainer', scene)} />);
    const card = screen.getByRole('region', { name: 'Catchment notebook' });
    expect(card).toHaveAttribute('contenteditable', 'false');
    expect(card).toHaveAttribute('data-narration-ignore', 'true');
    expect(card).toHaveAttribute('data-visual-artifact');
    const tank = screen.getByRole('img', { name: 'Upright tank' });
    expect(tank.querySelector('rect')).toHaveAttribute('height', '20');
    expect(screen.getByRole('img', { name: 'Mountain ridge' }).querySelector('path')).toHaveAttribute('d', 'M5 90 L45 12 L95 90 Z');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Winter' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Spring' })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Spring' })).toHaveTextContent('Meltwater reaches the reservoir.');
    expect(tank.querySelector('rect')).toHaveAttribute('height', '60');
    expect(tank.querySelector('rect')).toHaveAttribute('y', '30');
    expect(screen.getByRole('list', { name: 'Connections' })).toHaveTextContent('Runoff');
    expect(card.querySelectorAll('path[marker-end]')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Spring' }), { key: 'Home' });
    expect(screen.queryByRole('list', { name: 'Connections' })).toBeNull();
  });

  it('routes a direct flow around an intervening subject while keeping adjacent connections straight', () => {
    const subjects = ['Panels', 'Storage', 'Home'];
    const { container } = render(<VisualArtifactView artifact={artifact('explainer', {
      kind: 'scene',
      nodes: subjects.map((name, i) => ({ label: name, alt: name, x: i * 40 + 10, y: 50,
        shapes: [{ kind: 'rect', x: 0, y: 0, width: 100, height: 100, stroke: 'ink', fill: 'surface' }] })),
      frames: [{ label: 'Day', caption: 'Two direct connections.', values: ['', '', ''], levels: [null, null, null],
        flows: [{ from: 0, to: 2, label: '6 kW' }, { from: 0, to: 1, label: '2 kW' }] }],
    })} />);
    const [bypass, adjacent] = Array.from(container.querySelectorAll('path[marker-end]'), path =>
      Array.from(path.getAttribute('d')!.matchAll(/([ML]) ([\d.]+) ([\d.]+)/g),
        match => ({ x: Number(match[2]), y: Number(match[3]) })));
    expect(adjacent).toHaveLength(2);
    const row = adjacent[0].y;
    expect(adjacent[1].y).toBe(row);
    // Halfway across this row is the centre of Storage. Interpolate the
    // bypass there: its line must clear the full 78-unit symbol.
    const segment = bypass.findIndex((point, i) => i > 0 && point.x >= 320 && bypass[i - 1].x <= 320);
    expect(segment).toBeGreaterThan(0);
    const a = bypass[segment - 1], b = bypass[segment];
    const yAtStorage = a.y + (320 - a.x) * (b.y - a.y) / (b.x - a.x);
    expect(Math.abs(yAtStorage - row)).toBeGreaterThan(39);
  });

  it('shows chronological labels together and discloses the selected explanation', () => {
    render(<VisualArtifactView artifact={artifact('timeline', { kind: 'steps', items: [
      { label: 'April', heading: 'Survey', text: 'The team surveyed the valley.' },
      { label: 'May', heading: 'Report', text: 'The findings were published.' },
    ] })} />);
    expect(screen.getByText('The team surveyed the valley.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'May Report' }));
    expect(screen.getByText('The findings were published.')).toBeVisible();
    expect(screen.getByText('The team surveyed the valley.')).not.toBeVisible();
  });

  it('keeps quiz answers local across pages and preserves state across an identical note reparse', () => {
    const quiz = artifact('quiz', { kind: 'quiz', items: [
      { question: 'What melts?', choices: ['Snow', 'Rocks'], answer: 0, explanation: 'Snow melts into water.' },
      { question: 'Where does runoff collect?', choices: ['Reservoir', 'Cloud'], answer: 0, explanation: 'The reservoir stores water.' },
    ] });
    const { rerender } = render(<VisualArtifactView artifact={quiz} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rocks' }));
    expect(screen.getByText('Correct answer: Snow.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next question' }));
    expect(screen.queryByText('Correct answer: Snow.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous question' }));
    rerender(<VisualArtifactView artifact={JSON.parse(JSON.stringify(quiz))} />);
    expect(screen.getByRole('button', { name: 'Rocks' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides a flashcard answer when advancing or when an external edit replaces the block', () => {
    const cards = artifact('flashcards', { kind: 'cards', items: [
      { front: 'Catchment', back: 'Area that drains to one outlet' }, { front: 'Tributary', back: 'A smaller stream' },
    ] });
    const { rerender } = render(<VisualArtifactView artifact={cards} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show answer' }));
    expect(screen.getByText('Area that drains to one outlet')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next card' }));
    expect(screen.getByText('A smaller stream')).not.toBeVisible();
    rerender(<VisualArtifactView artifact={artifact('flashcards', { kind: 'cards', items: [
      { front: 'Estuary', back: 'Tidal mouth of a river' },
    ] })} />);
    expect(screen.getByText('Estuary')).toBeVisible();
    expect(screen.getByText('Tidal mouth of a river')).not.toBeVisible();
  });

  it('recalculates from a labelled native slider and handles an undefined result', () => {
    render(<VisualArtifactView artifact={artifact('calculator', { kind: 'calculator',
      inputs: [{ label: 'Inflow', unit: 'L/s', min: 0, max: 10, step: 1, initial: 2 }],
      outputs: [{ label: 'Time to fill', unit: 's', expression: { op: 'divide', left: 20, right: { input: 0 } } }],
    })} />);
    const slider = screen.getByRole('slider', { name: 'Inflow' });
    expect(screen.getByText('10 s')).toBeVisible();
    fireEvent.change(slider, { target: { value: '5' } });
    expect(slider).toHaveAttribute('aria-valuetext', '5 L/s');
    expect(screen.getByText('4 s')).toBeVisible();
    fireEvent.change(slider, { target: { value: '0' } });
    expect(screen.getByText('Undefined')).toBeVisible();
  });

  it('renders readable table headers and treats generated prose as literal text', () => {
    render(<VisualArtifactView artifact={artifact('comparison',
      { kind: 'text', heading: 'Survey', text: '<b>Field note</b>' },
      { kind: 'table', columns: ['Basin', 'Volume'], rows: [['Upper', '40 L']] },
    )} />);
    const table = screen.getByRole('table', { name: 'Catchment notebook' });
    expect(within(table).getByRole('columnheader', { name: 'Volume' })).toBeVisible();
    expect(within(table).getByRole('rowheader', { name: 'Upper' })).toBeVisible();
    expect(screen.getByText('<b>Field note</b>')).toBeVisible();
  });
});
