const GROUP_SIZE = 64;
const GROUP_THRESHOLD = 500;

export function createPlaylistRows(container) {
    let rows = [], matches = [], groups = [], grouped = false, visibleCount = 0, visibleIndexes = null;

    function updateGroup(group) {
        const end = Math.min(group.start + GROUP_SIZE, rows.length);
        let count = 0;
        for (let index = group.start; index < end; index++) count += Number(matches[index]);
        if (group.element.hidden !== (count === 0)) group.element.hidden = count === 0;
        if (count === end - group.start) {
            if (group.mixed) for (let index = group.start; index < end; index++) if (rows[index].hidden) rows[index].hidden = false;
            group.mixed = false;
        } else if (count) {
            for (let index = group.start; index < end; index++) {
                if (rows[index].hidden === matches[index]) rows[index].hidden = !matches[index];
            }
            group.mixed = true;
        }
        if (group.count !== count) {
            group.count = count;
            group.element.style.setProperty('--playlist-visible-rows', String(count));
        }
    }

    function appendGrouped(start) {
        for (let index = start; index < rows.length; index++) {
            const groupIndex = Math.floor(index / GROUP_SIZE);
            let group = groups[groupIndex];
            if (!group) {
                const element = document.createElement('div');
                element.className = 'pl-row-group';
                group = { element, start: index, count: -1, mixed: true };
                groups.push(group);
                container.appendChild(element);
            }
            group.element.appendChild(rows[index]);
        }
        for (let index = Math.floor(start / GROUP_SIZE); index < groups.length; index++) updateGroup(groups[index]);
    }

    return {
        get length() { return rows.length; },
        get visibleCount() { return visibleCount; },
        at: index => rows[index],
        isVisible: index => !!matches[index],
        visibleIndexes() {
            if (!visibleIndexes) {
                visibleIndexes = [];
                for (let index = 0; index < matches.length; index++) if (matches[index]) visibleIndexes.push(index);
            }
            return visibleIndexes;
        },
        clear() {
            rows = []; matches = []; groups = []; grouped = false; visibleCount = 0; visibleIndexes = null;
            container.innerHTML = '';
        },
        append(nextRows, nextMatches) {
            const start = rows.length;
            for (const row of nextRows) rows.push(row);
            for (const match of nextMatches) matches.push(match);
            visibleCount += nextMatches.filter(Boolean).length;
            visibleIndexes = null;
            if (!grouped && rows.length > GROUP_THRESHOLD) {
                grouped = true;
                container.innerHTML = '';
                appendGrouped(0);
            } else if (grouped) appendGrouped(start);
            else {
                const fragment = document.createDocumentFragment();
                nextRows.forEach((row, index) => { row.hidden = !nextMatches[index]; fragment.appendChild(row); });
                container.appendChild(fragment);
            }
        },
        filter(predicate) {
            visibleCount = 0; visibleIndexes = null;
            matches = rows.map((_, index) => {
                const match = !!predicate(index);
                visibleCount += Number(match);
                return match;
            });
            if (grouped) groups.forEach(updateGroup);
            else rows.forEach((row, index) => { if (row.hidden === matches[index]) row.hidden = !matches[index]; });
        },
        setVisible(index, visible) {
            if (!rows[index] || matches[index] === visible) return false;
            visibleCount += visible ? 1 : -1;
            matches[index] = visible; visibleIndexes = null;
            if (grouped) updateGroup(groups[Math.floor(index / GROUP_SIZE)]);
            else rows[index].hidden = !visible;
            return true;
        }
    };
}
