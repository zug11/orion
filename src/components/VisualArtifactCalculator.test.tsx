import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseVisualArtifact, type ArtifactExpression } from '../lib/visualArtifacts';
import { validateGeneratedCalculatorRanges } from '../lib/visualArtifactCalculatorRanges';
import { expressionWorking, type CalculatorBlock } from '../lib/visualArtifactCalculator';
import { readVisualArtifactMarker, visualArtifactMarker } from '../lib/visualArtifactMarkdown';
import { VisualArtifactCalculator } from './VisualArtifactCalculator';
import { VisualArtifactView } from './VisualArtifactView';

const slider = {label:'Guests', unit:'guests', min:1, max:10, step:1, initial:4};
const recipe:CalculatorBlock = {
  kind:'calculator', inputs:[slider], outputs:[{label:'Rice',unit:'g',expression:{op:'multiply',left:50,right:{input:0}}}],
  presets:[{label:'Dinner for six',values:[6]}], recipe:{input:0,ingredients:[0]},
  explanation:['For ',{input:0},', use ',{output:0},' of rice.'],
};
const read = (block:unknown) => parseVisualArtifact({version:1,title:'Test a passage',format:'calculator',blocks:[block]});
afterEach(cleanup);

describe('passage calculators', () => {
  it('rescales one ingredient table, retains the as-written quantity, and adds only the current shopping list', () => {
    const block: CalculatorBlock = {...recipe, explanation: undefined, presets: undefined,
      recipe: {...recipe.recipe!, cookingNote: 'Simmer for 15 minutes.'}};
    const art = read(block);
    validateGeneratedCalculatorRanges(art);
    expect(readVisualArtifactMarker(visualArtifactMarker(art))).toEqual(art);
    const add = vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<VisualArtifactCalculator block={block} onAddTasks={add}/>);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.queryByRole('button', {name:/Show working/})).toBeNull();
    expect(screen.getByLabelText('Ingredient calculation')).not.toBeVisible();
    const stepper = within(screen.getByRole('group', {name:'Guests'}));
    fireEvent.click(stepper.getByRole('button', {name:'Increase Guests'}));
    expect(stepper.getByRole('status')).toHaveTextContent('5');
    expect(screen.getByRole('columnheader',{name:'For 4, as written'})).toBeVisible();
    expect(screen.getByRole('columnheader',{name:'For 5'})).toBeVisible();
    const row = within(screen.getByRole('row',{name:/Rice/}));
    expect(row.getByText('200 g')).toBeVisible();
    expect(row.getByText('250 g')).toBeVisible();
    expect(screen.getByText('Simmer for 15 minutes.')).toBeVisible();
    const addButton = screen.getByRole('button',{name:'Add shopping list as to-dos'});
    fireEvent.click(addButton);
    expect(screen.getByText(/The note changed/)).toBeVisible();
    fireEvent.click(addButton);
    expect(add).toHaveBeenCalledWith(['250 g Rice']);
    expect(screen.getByRole('button',{name:'Shopping list added'})).toBeDisabled();
    fireEvent.click(stepper.getByRole('button',{name:'Decrease Guests'}));
    expect(screen.getByRole('button',{name:'Add shopping list as to-dos'})).toBeEnabled();
    fireEvent.click(screen.getByText('Recipe details'));
    fireEvent.change(screen.getByRole('combobox', {name:'Ingredient calculation'}), {target:{value:'0'}});
    expect(screen.getByText('50 × Guests (4) = 200')).toBeVisible();
    fireEvent.click(stepper.getByRole('button', {name:'Increase Guests'}));
    expect(screen.getByText('50 × Guests (5) = 250')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name:'Back to the passage'}));
    expect(stepper.getByRole('status')).toHaveTextContent('4');
  });
  it('uses reachable decimal ticks and authored measurement units for the scaling control', () => {
    const block = {...recipe, inputs:[{...slider,label:'Batch weight',unit:'kg',min:.1,max:.35,initial:.1,step:.1}]};
    render(<VisualArtifactCalculator block={block}/>);
    const up = screen.getByRole('button', {name:'Increase Batch weight'});
    const down = screen.getByRole('button', {name:'Decrease Batch weight'});
    expect(down).toBeDisabled();
    fireEvent.click(up);
    fireEvent.click(up);
    expect(up).toBeDisabled();
    expect(screen.getByRole('columnheader', {name:'For 0.3 kg'})).toBeVisible();
    fireEvent.click(down);
    expect(up).toBeEnabled();
    expect(screen.getByRole('columnheader', {name:'For 0.2 kg'})).toBeVisible();
  });
  it('keeps authored controls, a chart, extra outputs and method in disclosures on older recipes', () => {
    const block: CalculatorBlock = {...recipe, inputs: [slider, {...slider,label:'Rice price',unit:'$'}],
      presets: [{label:'Dinner for six',values:[6,4]}],
      outputs: [...recipe.outputs, {label:'Total cost',unit:'$',expression:{op:'multiply',left:{input:0},right:{input:1}}}],
      chart:{input:0,outputs:[1]}};
    const art = parseVisualArtifact({version:1, format:'calculator',title:'Rice for dinner',
      blocks: [{kind:'text',heading:'Finishing',text:'Let the rice rest.'},block]});
    render(<VisualArtifactView artifact={art}/>);
    expect(screen.getByText('Finishing')).not.toBeVisible();
    expect(screen.getByText('Dinner for six')).not.toBeVisible();
    fireEvent.click(screen.getByText('Method'));
    expect(screen.getByText('Let the rice rest.')).toBeVisible();
    fireEvent.click(screen.getByText('Recipe details'));
    fireEvent.click(screen.getByRole('button',{name:'Dinner for six'}));
    expect(screen.getByText(/For /,{selector:'p'})).toHaveTextContent('For 6 guests, use 300 g of rice.');
    fireEvent.change(screen.getByRole('slider',{name:'Rice price'}), {target:{value:5}});
    expect(screen.getByText('$30.00',{selector:'dd'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Show working for Total cost'}));
    expect(screen.getByText('Guests (6) × Rice price (5) = 30')).toBeVisible();
    expect(screen.getByRole('img',{name:'Total cost by Guests'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Back to the passage'}));
    expect(screen.getByRole('columnheader',{name:'For 4'})).toBeVisible();
    expect(screen.queryByRole('button',{name:'Show working for Rice'})).toBeNull();
  });
  it('preserves lazy rules on a zero-denominator branch and names discrete outcomes', () => {
    const rule:ArtifactExpression = {op:'ifLess',left:{input:0},right:1,then:0,else:{op:'divide',left:1,right:{input:0}}};
    const block:CalculatorBlock = {...recipe,recipe:undefined,inputs:[{...slider,min:0,initial:0,unit:'',label:'Return'}],
      outputs:[{label:'Position',unit:'',expression:rule,labels:[{label:'Cash',value:0}]}]};
    expect(() => validateGeneratedCalculatorRanges(read(block))).not.toThrow();
    expect(expressionWorking(rule,block.inputs,[0]).join(' ')).not.toContain('÷');
    render(<VisualArtifactCalculator block={block}/>);
    expect(screen.getByText('Cash',{selector:'dd'})).toBeVisible();
    fireEvent.change(screen.getByRole('slider',{name:'Return'}),{target:{value:2}});
    expect(screen.getByText('0.5',{selector:'dd'})).toBeVisible();
  });
  it('checks source population totals at reachable settings and explains each whole count', () => {
    const full = {op:'round',value:{input:0}} as const;
    const block:CalculatorBlock = {kind:'calculator',inputs:[{...slider,min:0,max:10,initial:1}],
      outputs:[{label:'Selected',unit:'',expression:full},{label:'Remaining',unit:'',expression:{op:'subtract',left:10,right:full}}],
      counts:{outputs:[0,1],total:10}};
    validateGeneratedCalculatorRanges(read(block));
    expect(() => validateGeneratedCalculatorRanges(read({...block,outputs:[block.outputs[0],{...block.outputs[1],expression:9}]}))).toThrow(/add up/);
    render(<VisualArtifactCalculator block={block}/>);
    const dots = screen.getByRole('img',{name:'Selected 1, Remaining 9'});
    expect(dots.querySelectorAll('circle')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button',{name:'Remaining · 9'}));
    expect(dots.querySelector('g')).toHaveAttribute('opacity','0.12');
    fireEvent.change(screen.getByRole('slider',{name:'Guests'}),{target:{value:4}});
    expect(screen.getByRole('img',{name:'Selected 4, Remaining 6'})).toBeVisible();
  });
  it('derives all four screening cohorts from the passage without rounding drift', () => {
    const multiply = (left: ArtifactExpression, right: ArtifactExpression): ArtifactExpression => ({op:'multiply',left,right});
    const subtract = (left: ArtifactExpression, right: ArtifactExpression): ArtifactExpression => ({op:'subtract',left,right});
    const fraction = (i:number): ArtifactExpression => ({op:'divide',left:{input:i},right:100});
    const rounded = (value:ArtifactExpression): ArtifactExpression => ({op:'round',value});
    const cases = rounded(multiply(1000,fraction(0)));
    const others = subtract(1000,cases);
    const tp = rounded(multiply(cases,fraction(1)));
    const fp = rounded(multiply(others,fraction(2)));
    const block: CalculatorBlock = {kind:'calculator',
      inputs:[{...slider,label:'Prevalence',min:.1,max:20,step:.1,initial:1},{...slider,label:'Sensitivity',min:50,max:100,initial:90},
        {...slider,label:'False positives',min:0,max:30,initial:9}],
      outputs:[tp,subtract(cases,tp),fp,subtract(others,fp)].map((expression,i)=>({label:['True positive','False negative','False positive','True negative'][i],unit:'',expression})),
      counts:{total:1000,outputs:[0,1,2,3]}};
    validateGeneratedCalculatorRanges(read(block));
    render(<VisualArtifactCalculator block={block}/>);
    expect(screen.getByRole('img',{name:'True positive 9, False negative 1, False positive 89, True negative 901'})).toBeVisible();
  });
  it('maps pointer and settle actions on the chart onto the slider grid', () => {
    const block:CalculatorBlock = {
      kind:'calculator',inputs:[{...slider,label:'Price',min:0,unit:'$'}, {...slider,label:'Demand shift',min:0,unit:''}],
      outputs:[
        {label:'Demand',unit:'units',expression:{op:'add',left:{input:1},right:{op:'subtract',left:10,right:{input:0}}}},
        {label:'Supply',unit:'units',expression:{input:0}},
        {label:'Equilibrium',unit:'$',expression:{op:'divide',left:{op:'add',left:10,right:{input:1}},right:2}},
      ],chart:{input:0,outputs:[0,1],dragInput:1,settleOutput:2},
    };
    validateGeneratedCalculatorRanges(read(block));
    render(<VisualArtifactCalculator block={block}/>);
    const chart = screen.getByRole('img',{name:'Demand and Supply by Price'});
    vi.spyOn(chart,'getBoundingClientRect').mockReturnValue({x:0,y:0,top:0,left:0,right:540,bottom:180,width:540,height:180,toJSON:()=>({})});
    vi.stubGlobal('PointerEvent', MouseEvent);
    try {
      fireEvent.pointerDown(chart,{button:0,clientX:270,clientY:50});
      fireEvent.pointerUp(chart);
      expect(screen.getByRole('slider',{name:'Price'})).toHaveValue('5');
      fireEvent.pointerDown(chart.querySelector('[data-curve-handle] circle')!,{button:0,clientX:270,clientY:50});
      fireEvent.pointerMove(chart,{clientX:270,clientY:20});
      fireEvent.pointerUp(chart);
      expect(Number((screen.getByRole('slider',{name:'Demand shift'}) as HTMLInputElement).value)).toBeGreaterThan(4);
      fireEvent.click(screen.getByRole('button',{name:'Set Price to Equilibrium'}));
      expect(Number((screen.getByRole('slider',{name:'Price'}) as HTMLInputElement).value)).toBeGreaterThan(5);
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects off-grid presets, mixed-unit series, malformed nested keys and duplicate references', () => {
    for (const invalid of [
      {...recipe,presets:[{label:'No',values:[2.5]}]},
      {...recipe,chart:{input:0,outputs:[0],dragInput:0}},
      {...recipe,outputs:[...recipe.outputs,{label:'Other',unit:'kg',expression:1}],chart:{input:0,outputs:[0,1]}},
      {...recipe,recipe:{input:0,ingredients:[0,0]}},
      {...recipe,explanation:[{input:0,output:0}]},
      {...recipe,outputs:[{label:'Invalid',unit:'',expression:{op:'round',value:1,unexpected:1}}]},
    ]) expect(() => read(invalid)).toThrow();
  });
});
