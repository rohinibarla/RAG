/** Rail Announcements Generator. By Roy Curtis, MIT license, 2018 */

/** Utility methods for dealing with collapsible elements */
class Collapsibles
{
    /**
     * Sets the collapse state of a collapsible element.
     *
     * @param span The encapsulating collapsible element
     * @param toggle The toggle child of the collapsible element
     * @param state True to collapse, false to open
     */
    public static set(span: HTMLElement, toggle: HTMLElement, state: boolean) : void
    {
        if (state) span.setAttribute('collapsed', '');
        else       span.removeAttribute('collapsed');

        toggle.title = state
            ? L.TITLE_OPT_OPEN()
            : L.TITLE_OPT_CLOSE();
    }
}