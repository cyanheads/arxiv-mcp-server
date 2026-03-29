/**
 * @fileoverview Barrel export for all resource definitions.
 * @module mcp-server/resources/definitions
 */

import { categoriesResource } from './categories.resource.js';
import { paperResource } from './paper.resource.js';

export const allResourceDefinitions = [paperResource, categoriesResource];
