import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseVisualArtifact, type ArtifactExpression } from '../lib/visualArtifacts';
import { validateGeneratedCalculatorRanges } from '../lib/visualArtifactCalculatorRanges';
import { expressionWorking, type CalculatorBlock } from '../lib/visualArtifactCalculator';
import { readVisualArtifactMarker, visualArtifactMarker } from '../lib/visualArtifactMarkdown';
import { VisualArtifactCalculator } from './VisualArtifactCalculator';

const slider = {label:'Guests', unit:'guests', min:1, max:10, step:1, initial:4};
const recipe:CalculatorBlock = {
  kind:'calculator', inputs:[slider], outputs:[{label:'Rice',unit:'g',expression:{op:'multiply',left:50,right:{input:0}}}],
  presets:[{label:'Dinner for six',values:[6]}], recipe:{input:0,ingredients:[0]},
  explanation:['For ',{input:0},', use ',{output:0},' of rice.'],
};
const read = (block:unknown) => parseVisualArtifact({version:1,title:'Test a passage',format:'calculator',blocks:[block]});
afterEach(cleanup);

describe('passage calculators', () => {
  it('round-trips the native marker and keeps prose, servings, working and shopping rows in sync', () => {
    const art = read(recipe);
    validateGeneratedCalculatorRanges(art);
    expect(readVisualArtifactMarker(visualArtifactMarker(art))).toEqual(art);
    const add = vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<VisualArtifactCalculator block={recipe} onAddTasks={add}/>);
    fireEvent.click(screen.getByRole('button',{name:'Dinner for six'}));
    expect(screen.getByText(/For /,{selector:'p'})).toHaveTextContent('For 6 guests, use 300 g of rice.');
    fireEvent.keyDown(screen.getByRole('slider',{name:'Adjust Guests in explanation'}), {key:'ArrowRight'});
    const row = within(screen.getByRole('row',{name:/Rice/}));
    expect(row.getByText('350 g')).toBeVisible();
    expect(row.getByText('200 g')).toBeVisible();
    expect(screen.getByRole('slider',{name:'Guests'})).toHaveAttribute('aria-valuetext','7 guests');
    const addButton = screen.getByRole('button',{name:'Add shopping list as to-dos'});
    fireEvent.click(addButton);
    expect(screen.getByRole('status')).toHaveTextContent('note changed');
    fireEvent.click(addButton);
    expect(add).toHaveBeenCalledWith(['350 g Rice']);
    expect(screen.getByRole('button',{name:'Shopping list added'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Show working for Rice'}));
    expect(screen.getByText('50 × Guests (7) = 350')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Back to the passage'}));
    expect(screen.getByText('50 × Guests (4) = 200')).toBeVisible();
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
