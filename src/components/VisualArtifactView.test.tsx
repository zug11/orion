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
  it('keeps the author’s graphics and level values when navigating stages by keyboard', () => {
    render(<VisualArtifactView artifact={artifact('explainer', scene)} />);
    const card = screen.getByRole('region', { name: 'Catchment notebook' });
    expect(card).toHaveAttribute('contenteditable', 'false');
    expect(card).toHaveAttribute('data-narration-ignore', 'true');
    expect(card).toHaveAttribute('data-visual-artifact');
    const winterTab = screen.getByRole('tab', { name: 'Winter' });
    const springTab = screen.getByRole('tab', { name: 'Spring' });
    const winter = screen.getByRole('tabpanel', { name: 'Winter' });
    expect(winterTab).toHaveAttribute('aria-selected', 'true');
    expect(winterTab).toHaveAttribute('aria-controls', winter.id);
    expect(within(winter).getByRole('img', { name: 'Mountain ridge' }).querySelector('path'))
      .toHaveAttribute('d', 'M5 90 L45 12 L95 90 Z');
    expect(within(winter).getByRole('img', { name: 'Upright tank' }).querySelector('rect'))
      .toHaveAttribute('height', '20');

    fireEvent.keyDown(winterTab, { key: 'ArrowRight' });
    const spring = screen.getByRole('tabpanel', { name: 'Spring' });
    expect(springTab).toHaveFocus();
    expect(springTab).toHaveAttribute('aria-selected', 'true');
    expect(winterTab).toHaveAttribute('aria-selected', 'false');
    expect(spring).toHaveTextContent('Meltwater reaches the reservoir.');
    const springTank = within(spring).getByRole('img', { name: 'Upright tank' });
    expect(springTank.querySelector('rect')).toHaveAttribute('height', '60');
    expect(springTank.querySelector('rect')).toHaveAttribute('y', '30');
    expect(spring.querySelectorAll('path[marker-end]')).toHaveLength(1);
    expect(within(spring).getByRole('list', { name: 'Connections' })).toHaveTextContent('Runoff');

    fireEvent.keyDown(springTab, { key: 'Home' });
    expect(winterTab).toHaveFocus();
    expect(screen.queryByRole('list', { name: 'Connections' })).toBeNull();
  });

  it('focuses the drawings on the current flow and keeps other reported values in the stage', () => {
    const names = ['Panels', 'Storage', 'Home', 'Grid'];
    render(<VisualArtifactView artifact={artifact('explainer', {
      kind: 'scene',
      nodes: names.map((label, index) => ({ label, alt: label + ' drawing', x: index * 20, y: 50,
        shapes: [{ kind: 'rect', x: 4, y: 4, width: 92, height: 92, stroke: 'ink', fill: 'surface' }] })),
      frames: [
        { label: 'Day', caption: 'Solar supplies the home and charges storage.', values: ['8 kW', 'Charging', '6 kW', ''],
          levels: [null, null, null, null], flows: [{ from: 0, to: 2, label: '6 kW' }, { from: 0, to: 1, label: '2 kW' }] },
        { label: 'Night', caption: 'Storage supplies the home.', values: ['Idle', 'Discharging', '2 kW', ''],
          levels: [null, null, null, null], flows: [{ from: 1, to: 2, label: '2 kW' }] },
      ],
    })} />);
    const day = screen.getByRole('tabpanel', { name: 'Day' });
    for (const name of ['Panels', 'Storage', 'Home']) expect(within(day).getByRole('img', { name: name + ' drawing' })).toBeInTheDocument();
    expect(within(day).queryByRole('img', { name: 'Grid drawing' })).toBeNull();
    const flows = within(within(day).getByRole('list', { name: 'Connections' })).getAllByRole('listitem');
    expect(flows).toHaveLength(2);
    expect(flows[0]).toHaveTextContent(/Panels.*Home/);
    expect(flows[0]).toHaveTextContent('6 kW');
    expect(flows[1]).toHaveTextContent(/Panels.*Storage/);
    expect(flows[1]).toHaveTextContent('2 kW');
    const diagram = day.querySelector<SVGSVGElement>('svg.visual-artifact__connections')!;
    const tip = diagram.querySelector('marker')!;
    const arrows = diagram.querySelectorAll('path[marker-end]');
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) expect(arrow).toHaveAttribute('marker-end', `url(#${tip.id})`);
    expect(Array.from(diagram.querySelectorAll('text'), label => label.textContent)).toEqual(['6 kW', '2 kW']);

    fireEvent.click(screen.getByRole('tab', { name: 'Night' }));
    const night = screen.getByRole('tabpanel', { name: 'Night' });
    expect(within(night).queryByRole('img', { name: 'Panels drawing' })).toBeNull();
    expect(within(night).queryByRole('img', { name: 'Grid drawing' })).toBeNull();
    for (const name of ['Storage', 'Home']) expect(within(night).getByRole('img', { name: name + ' drawing' })).toBeInTheDocument();
    const readings = within(night).getByLabelText('Other readings');
    expect(readings).toHaveTextContent('Panels');
    expect(readings).toHaveTextContent('Idle');
    expect(night).toHaveTextContent('Storage supplies the home.');
    const remaining = within(within(night).getByRole('list', { name: 'Connections' })).getAllByRole('listitem');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveTextContent(/Storage.*Home/);
  });

  it('preserves every directed relation in a cyclic scene', () => {
    const nodes = scene.nodes;
    const flows = [{ from: 0, to: 1, label: 'Runoff' }, { from: 1, to: 0, label: 'Evaporation' }];
    render(<VisualArtifactView artifact={artifact('explainer', { kind: 'scene', nodes,
      frames: [{ label: 'Water cycle', caption: 'Water moves between the two reservoirs.', values: ['', ''],
        levels: [null, null], flows }],
    })} />);
    const stage = screen.getByRole('group', { name: 'Water cycle' });
    const relations = within(within(stage).getByRole('list', { name: 'Connections' })).getAllByRole('listitem');
    expect(relations).toHaveLength(2);
    expect(relations[0]).toHaveTextContent(/Snowpack.*Reservoir/);
    expect(relations[0]).toHaveTextContent('Runoff');
    expect(relations[1]).toHaveTextContent(/Reservoir.*Snowpack/);
    expect(relations[1]).toHaveTextContent('Evaporation');
    expect(stage.querySelector('path[marker-end]')).toBeNull();
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
