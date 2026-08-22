export interface LayoutFixture {
  filename: string;
  feature: string;
}

export const layoutFixtures: LayoutFixture[] = [
  { filename: 'sequential.bpmn', feature: 'sequential' },
  { filename: 'branch-rejoin.bpmn', feature: 'branch/rejoin' },
  { filename: 'skip-flow.bpmn', feature: 'skip flow' },
  { filename: 'cycle.bpmn', feature: 'cycle' },
  { filename: 'self-loop.bpmn', feature: 'self-loop' },
  { filename: 'long-labels.bpmn', feature: 'long labels' },
  { filename: 'collaboration-message-flow.bpmn', feature: 'collaboration/message flow' },
  { filename: 'lanes.bpmn', feature: 'lanes' },
  { filename: 'subprocess-boundary.bpmn', feature: 'subprocess/boundary event' }
];
