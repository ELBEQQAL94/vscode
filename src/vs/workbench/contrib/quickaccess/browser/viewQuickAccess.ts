/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { IQuickPickSeparator, IQuickInputService, ItemActivation } from 'vs/platform/quickinput/common/quickInput';
import { IPickerQuickAccessItem, PickerQuickAccessProvider } from 'vs/platform/quickinput/browser/pickerQuickAccess';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { IViewDescriptorService, IViewsService, ViewContainer, Extensions as ViewExtensions, IViewContainersRegistry } from 'vs/workbench/common/views';
import { IOutputService } from 'vs/workbench/contrib/output/common/output';
import { ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { IPanelService, IPanelIdentifier } from 'vs/workbench/services/panel/common/panelService';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ViewletDescriptor } from 'vs/workbench/browser/viewlet';
import { matchesFuzzy } from 'vs/base/common/filters';
import { fuzzyContains } from 'vs/base/common/strings';
import { withNullAsUndefined } from 'vs/base/common/types';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { Action } from 'vs/base/common/actions';

interface IViewQuickPickItem extends IPickerQuickAccessItem {
	containerLabel: string;
}

export class ViewQuickAccessProvider extends PickerQuickAccessProvider<IViewQuickPickItem> {

	static PREFIX = 'view ';

	constructor(
		@IViewletService private readonly viewletService: IViewletService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IViewsService private readonly viewsService: IViewsService,
		@IOutputService private readonly outputService: IOutputService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IPanelService private readonly panelService: IPanelService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService
	) {
		super(ViewQuickAccessProvider.PREFIX, {
			noResultsPick: {
				label: localize('noViewResults', "No matching views"),
				containerLabel: ''
			}
		});
	}

	protected getPicks(filter: string): Array<IViewQuickPickItem | IQuickPickSeparator> {
		const filteredViewEntries = this.doGetViewPickItems().filter(entry => {
			if (!filter) {
				return true;
			}

			// Match fuzzy on label
			entry.highlights = { label: withNullAsUndefined(matchesFuzzy(filter, entry.label, true)) };

			// Return if we have a match on label or container
			return entry.highlights.label || fuzzyContains(entry.containerLabel, filter);
		});

		// Map entries to container labels
		const mapEntryToContainer = new Map<string, string>();
		for (const entry of filteredViewEntries) {
			if (!mapEntryToContainer.has(entry.label)) {
				mapEntryToContainer.set(entry.label, entry.containerLabel);
			}
		}

		// Add separators for containers
		const filteredViewEntriesWithSeparators: Array<IViewQuickPickItem | IQuickPickSeparator> = [];
		let lastContainer: string | undefined = undefined;
		for (const entry of filteredViewEntries) {
			if (lastContainer !== entry.containerLabel) {
				lastContainer = entry.containerLabel;

				// When the entry container has a parent container, set container
				// label as Parent / Child. For example, `Views / Explorer`.
				let separatorLabel: string;
				if (mapEntryToContainer.has(lastContainer)) {
					separatorLabel = `${mapEntryToContainer.get(lastContainer)} / ${lastContainer}`;
				} else {
					separatorLabel = lastContainer;
				}

				filteredViewEntriesWithSeparators.push({ type: 'separator', label: separatorLabel });

			}

			filteredViewEntriesWithSeparators.push(entry);
		}

		return filteredViewEntriesWithSeparators;
	}

	private doGetViewPickItems(): Array<IViewQuickPickItem> {
		const viewEntries: Array<IViewQuickPickItem> = [];

		const getViewEntriesForViewlet = (viewlet: ViewletDescriptor, viewContainer: ViewContainer): IViewQuickPickItem[] => {
			const viewDescriptors = this.viewDescriptorService.getViewDescriptors(viewContainer);
			const result: IViewQuickPickItem[] = [];
			for (const view of viewDescriptors.allViewDescriptors) {
				if (this.contextKeyService.contextMatchesRules(view.when)) {
					result.push({
						label: view.name,
						containerLabel: viewlet.name,
						accept: () => this.viewsService.openView(view.id, true)
					});
				}
			}

			return result;
		};

		// Viewlets
		const viewlets = this.viewletService.getViewlets();
		for (const viewlet of viewlets) {
			if (this.includeViewContainer(viewlet)) {
				viewEntries.push({
					label: viewlet.name,
					containerLabel: localize('views', "Side Bar"),
					accept: () => this.viewletService.openViewlet(viewlet.id, true)
				});
			}
		}

		// Panels
		const panels = this.panelService.getPanels();
		for (const panel of panels) {
			if (this.includeViewContainer(panel)) {
				viewEntries.push({
					label: panel.name,
					containerLabel: localize('panels', "Panel"),
					accept: () => this.panelService.openPanel(panel.id, true)
				});
			}
		}

		// Viewlet Views
		for (const viewlet of viewlets) {
			const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(viewlet.id);
			if (viewContainer) {
				viewEntries.push(...getViewEntriesForViewlet(viewlet, viewContainer));
			}
		}

		// Terminals
		this.terminalService.terminalTabs.forEach((tab, tabIndex) => {
			tab.terminalInstances.forEach((terminal, terminalIndex) => {
				const label = localize('terminalTitle', "{0}: {1}", `${tabIndex + 1}.${terminalIndex + 1}`, terminal.title);
				viewEntries.push({
					label,
					containerLabel: localize('terminals', "Terminal"),
					accept: async () => {
						await this.terminalService.showPanel(true);

						this.terminalService.setActiveInstance(terminal);
					}
				});
			});
		});

		// Output Channels
		const channels = this.outputService.getChannelDescriptors();
		for (const channel of channels) {
			const label = channel.log ? localize('logChannel', "Log ({0})", channel.label) : channel.label;
			viewEntries.push({
				label,
				containerLabel: localize('channels', "Output"),
				accept: () => this.outputService.showChannel(channel.id)
			});
		}

		return viewEntries;
	}

	private includeViewContainer(container: ViewletDescriptor | IPanelIdentifier): boolean {
		const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(container.id);
		if (viewContainer?.hideIfEmpty) {
			return this.viewDescriptorService.getViewDescriptors(viewContainer).activeViewDescriptors.length > 0;
		}

		return true;
	}
}


//#region Actions

export class OpenViewPickerAction extends Action {

	static readonly ID = 'workbench.action.openView';
	static readonly LABEL = localize('openView', "Open View");

	constructor(
		id: string,
		label: string,
		@IQuickInputService private readonly quickInputService: IQuickInputService
	) {
		super(id, label);
	}

	async run(): Promise<void> {
		this.quickInputService.quickAccess.show(ViewQuickAccessProvider.PREFIX);
	}
}

export class QuickAccessViewPickerAction extends Action {

	static readonly ID = 'workbench.action.quickOpenView';
	static readonly LABEL = localize('quickOpenView', "Quick Open View");

	constructor(
		id: string,
		label: string,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IKeybindingService private readonly keybindingService: IKeybindingService
	) {
		super(id, label);
	}

	async run(): Promise<void> {
		const keys = this.keybindingService.lookupKeybindings(this.id);

		this.quickInputService.quickAccess.show(ViewQuickAccessProvider.PREFIX, { quickNavigateConfiguration: { keybindings: keys }, itemActivation: ItemActivation.FIRST });
	}
}

//#endregion
