import type { MermaidAST, MermaidNode } from '../converters/ASTTypes.js';
import {
  MERMAID_NODE_SIZES,
  MermaidAstLayoutAdapter
} from './layout/adapters/MermaidAstLayoutAdapter.js';
import { compareLayoutIds, refreshLayoutGeometry, type LayoutModel } from './layout/LayoutModel.js';

export type LayoutResult = LayoutModel;
export type { LayoutModel, LayoutNode } from './layout/LayoutModel.js';

export class LayoutEngine {
  private readonly DEFAULT_SPACING = {
    horizontal: 150,
    vertical: 100,
    poolHorizontal: 50
  };

  layout(ast: MermaidAST): LayoutResult {
    const layoutResult = MermaidAstLayoutAdapter.toLayoutModel(ast);
    const levels = this.computeLevels(ast);
    const spacing = this.calculateDynamicSpacing(ast);
    const orderedLevels = [...levels.entries()].sort(([left], [right]) => left - right);
    const maxDepth = orderedLevels.length === 0 ? 0 : Math.max(...orderedLevels.map(([depth]) => depth));
    const horizontal = layoutResult.direction === 'left-to-right'
      || layoutResult.direction === 'right-to-left';
    const reverse = layoutResult.direction === 'right-to-left'
      || layoutResult.direction === 'bottom-to-top';

    for (const [depth, level] of orderedLevels) {
      const rank = reverse ? maxDepth - depth : depth;
      if (horizontal) {
        const totalHeight = this.calculateLevelHeight(level, spacing.vertical);
        let currentY = (600 - totalHeight) / 2;
        for (const node of level) {
          const size = MERMAID_NODE_SIZES[node.type];
          layoutResult.nodes.get(node.id)!.bounds = {
            x: 100 + rank * (spacing.horizontal + 100),
            y: currentY,
            width: size.width,
            height: size.height
          };
          currentY += size.height + spacing.vertical;
        }
      } else {
        const totalWidth = this.calculateLevelWidth(level, spacing.horizontal);
        let currentX = (800 - totalWidth) / 2;
        for (const node of level) {
          const size = MERMAID_NODE_SIZES[node.type];
          layoutResult.nodes.get(node.id)!.bounds = {
            x: currentX,
            y: 100 + rank * (spacing.vertical + 100),
            width: size.width,
            height: size.height
          };
          currentX += size.width + spacing.horizontal;
        }
      }
    }

    this.updateContainerBounds(layoutResult, ast);
    this.resetEdgeGeometry(layoutResult);
    return refreshLayoutGeometry(layoutResult);
  }

  layoutWithPools(ast: MermaidAST): LayoutResult {
    const layoutResult = this.layout(ast);
    
    if (ast.subgraphs.length === 0) {
      return layoutResult;
    }

    const poolLayouts = [...ast.subgraphs]
      .sort((left, right) => compareLayoutIds(left.id, right.id))
      .map(subgraph => {
      const subgraphNodes = subgraph.nodes
        .map(nodeId => layoutResult.nodes.get(nodeId))
        .filter(node => node !== undefined);
      
      if (subgraphNodes.length === 0) return undefined;
      
      const bounds = {
        x: Math.min(...subgraphNodes.map(node => node.bounds.x)) - 20,
        y: Math.min(...subgraphNodes.map(node => node.bounds.y)) - 40,
        width: Math.max(...subgraphNodes.map(node => node.bounds.x + node.bounds.width))
          - Math.min(...subgraphNodes.map(node => node.bounds.x)) + 40,
        height: Math.max(...subgraphNodes.map(node => node.bounds.y + node.bounds.height))
          - Math.min(...subgraphNodes.map(node => node.bounds.y)) + 60
      };

      return {
        id: subgraph.id,
        nodes: subgraph.nodes,
        bounds
      };
    }).filter(pool => pool !== undefined);

    const horizontal = layoutResult.direction === 'left-to-right'
      || layoutResult.direction === 'right-to-left';
    let currentCrossAxis = 100;
    for (const pool of poolLayouts) {
      const delta = currentCrossAxis - (horizontal ? pool.bounds.y : pool.bounds.x);
      pool.nodes.forEach(nodeId => {
        const node = layoutResult.nodes.get(nodeId);
        if (node) {
          if (horizontal) node.bounds.y += delta;
          else node.bounds.x += delta;
        }
      });
      const container = layoutResult.containers.get(pool.id);
      if (container) {
        container.bounds = horizontal
          ? { ...pool.bounds, y: currentCrossAxis }
          : { ...pool.bounds, x: currentCrossAxis };
      }
      currentCrossAxis += (horizontal ? pool.bounds.height : pool.bounds.width)
        + this.DEFAULT_SPACING.poolHorizontal;
    }

    this.updateContainerBounds(layoutResult, ast);
    this.resetEdgeGeometry(layoutResult);
    return refreshLayoutGeometry(layoutResult);
  }

  private computeLevels(ast: MermaidAST): Map<number, MermaidNode[]> {
    const levels = new Map<number, MermaidNode[]>();
    const nodeLevel = new Map<string, number>();
    const visited = new Set<string>();
    
    const adjacencyList = this.buildAdjacencyList(ast);
    const startNodes = this.findStartNodes(ast);
    
    const sortedNodes = [...ast.nodes].sort((left, right) => compareLayoutIds(left.id, right.id));
    if (startNodes.length === 0 && sortedNodes.length > 0) {
      startNodes.push(sortedNodes[0]);
    }
    
    startNodes.forEach(startNode => {
      this.assignLevels(startNode, 0, adjacencyList, nodeLevel, visited, ast);
    });
    
    sortedNodes.forEach(node => {
      if (!visited.has(node.id)) {
        const minLevel = this.findMinPossibleLevel(node, adjacencyList, nodeLevel, ast);
        this.assignLevels(node, minLevel, adjacencyList, nodeLevel, visited, ast);
      }
    });
    
    [...ast.nodes].sort((left, right) => compareLayoutIds(left.id, right.id)).forEach(node => {
      const level = nodeLevel.get(node.id) || 0;
      if (!levels.has(level)) {
        levels.set(level, []);
      }
      levels.get(level)!.push(node);
    });
    
    return levels;
  }

  private assignLevels(
    node: MermaidNode,
    level: number,
    adjacencyList: Map<string, string[]>,
    nodeLevel: Map<string, number>,
    visited: Set<string>,
    ast: MermaidAST
  ): void {
    if (visited.has(node.id)) return;
    
    visited.add(node.id);
    nodeLevel.set(node.id, level);
    
    const neighbors = adjacencyList.get(node.id) || [];
    neighbors.forEach(neighborId => {
      const neighbor = ast.nodes.find(n => n.id === neighborId);
      if (neighbor && !visited.has(neighborId)) {
        this.assignLevels(neighbor, level + 1, adjacencyList, nodeLevel, visited, ast);
      }
    });
  }

  private buildAdjacencyList(ast: MermaidAST): Map<string, string[]> {
    const adjacencyList = new Map<string, string[]>();
    
    [...ast.nodes].sort((left, right) => compareLayoutIds(left.id, right.id)).forEach(node => {
      adjacencyList.set(node.id, []);
    });
    
    [...ast.edges].sort((left, right) => compareLayoutIds(left.id, right.id)).forEach(edge => {
      const sourceList = adjacencyList.get(edge.source) || [];
      sourceList.push(edge.target);
      sourceList.sort(compareLayoutIds);
      adjacencyList.set(edge.source, sourceList);
    });
    
    return adjacencyList;
  }

  private findStartNodes(ast: MermaidAST): MermaidNode[] {
    const hasIncoming = new Set<string>();
    ast.edges.forEach(edge => hasIncoming.add(edge.target));
    
    const startNodes = ast.nodes.filter(node => 
      !hasIncoming.has(node.id) || node.type === 'start'
    ).sort((left, right) => compareLayoutIds(left.id, right.id));
    
    return startNodes.length > 0 ? startNodes : [];
  }

  private findMinPossibleLevel(
    node: MermaidNode,
    _adjacencyList: Map<string, string[]>,
    nodeLevel: Map<string, number>,
    ast: MermaidAST
  ): number {
    const incomingNodes = ast.edges
      .filter(edge => edge.target === node.id)
      .map(edge => edge.source)
      .filter(sourceId => nodeLevel.has(sourceId));
    
    if (incomingNodes.length === 0) return 0;
    
    const maxIncomingLevel = Math.max(
      ...incomingNodes.map(sourceId => nodeLevel.get(sourceId) || 0)
    );
    
    return maxIncomingLevel + 1;
  }

  private calculateLevelWidth(nodes: MermaidNode[], spacing: number): number {
    return nodes.reduce((width, node) => {
      return width + MERMAID_NODE_SIZES[node.type].width + spacing;
    }, -spacing);
  }

  private calculateLevelHeight(nodes: MermaidNode[], spacing: number): number {
    return nodes.reduce((height, node) => height + MERMAID_NODE_SIZES[node.type].height + spacing, -spacing);
  }

  private calculateDynamicSpacing(ast: MermaidAST): typeof this.DEFAULT_SPACING {
    // Calculate max label length
    const maxLabelLength = Math.max(...ast.nodes.map(n => n.label.length), 10);
    
    // Calculate complexity metrics
    const nodeCount = ast.nodes.length;
    // Adjust spacing based on complexity
    const baseHorizontal = Math.max(150, maxLabelLength * 7);
    const baseVertical = nodeCount > 10 ? 120 : 100;
    
    return {
      horizontal: baseHorizontal,
      vertical: baseVertical,
      poolHorizontal: 50
    };
  }

  private updateContainerBounds(layout: LayoutModel, ast: MermaidAST): void {
    const update = (subgraph: MermaidAST['subgraphs'][number]): void => {
      for (const child of subgraph.subgraphs || []) update(child);
      const memberBounds = [
        ...subgraph.nodes.map(nodeId => layout.nodes.get(nodeId)?.bounds),
        ...(subgraph.subgraphs || []).map(child => layout.containers.get(child.id)?.bounds)
      ].filter(bounds => bounds !== undefined);
      if (memberBounds.length === 0) return;
      const minX = Math.min(...memberBounds.map(bounds => bounds.x));
      const minY = Math.min(...memberBounds.map(bounds => bounds.y));
      const maxX = Math.max(...memberBounds.map(bounds => bounds.x + bounds.width));
      const maxY = Math.max(...memberBounds.map(bounds => bounds.y + bounds.height));
      const container = layout.containers.get(subgraph.id);
      if (container) {
        container.bounds = {
          x: minX - 20,
          y: minY - 40,
          width: maxX - minX + 40,
          height: maxY - minY + 60
        };
      }
    };
    for (const subgraph of ast.subgraphs) update(subgraph);
  }

  private resetEdgeGeometry(layout: LayoutModel): void {
    for (const edge of layout.edges.values()) {
      edge.waypoints = [];
      edge.segments = [];
    }
  }

}
