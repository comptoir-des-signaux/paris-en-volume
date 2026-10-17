Build an interactive 3D map of Paris that shows every building in the city in volume, colored by its construction period.
The goal is an exceptional visual result, as beautiful and impressive as possible: a piece worthy of a great atlas, not a mere technical demo.
Expected result:

- Every building rises to its real height and is colored by its construction period.
- A legend lists each period with its share of the building stock. Clicking a period highlights it.
- A slider lets the viewer travel back in time, year by year, starting from 1800.
- The Seine, the canals and the parks are shown to give the city context.
- Trees can be shown or hidden.
- The map covers inner Paris (intra-muros), excluding the Bois de Boulogne and the Bois de Vincennes.

### Feature: Immersive 3D Fly-Through Navigation
Implement a **free-flight navigation mode** that allows users to fly through a 3D scene in any direction, with the following controls:

- **Mouse navigation:** Control the flight direction using the mouse pointer. The camera's target position moves forward or backward in the indicated direction, while the camera viewpoint automatically follows.
- **Progressive speed control:** Each additional mouse click in the same direction increases flight speed. Negative speed values indicate backward movement.
- **Keyboard controls:** Press the ↑ arrow key to increase speed and the ↓ arrow key to decrease speed.
- **SHIFT key:** Hold SHIFT to maintain a constant altitude while flying, regardless of the camera's orientation.
- **Real-time feedback:** Display the current flight speed and movement direction in a status bar.

**Expected behavior:** Provide smooth, responsive, and intuitive immersive 3D navigation, with precise control over flight direction, speed, and altitude.

**Important implementation considerations:**
- Distinguish between **constant-altitude flight** and **terrain-following flight**. These are separate behaviors.
- Maintaining a constant altitude does not automatically prevent collisions with terrain or obstacles.
- Ensure smooth camera transitions and progressive acceleration/deceleration to avoid abrupt movements.

Available data sources (ODbL license):

- Apur, "Emprise bâtie Paris" (construction period, year and height of each building): https://carto2.apur.org/apur/rest/services/OPENDATA/EMPRISE_BATIE_PARIS/MapServer/0
- Paris Open Data, "Arrondissements" (district boundaries): https://opendata.paris.fr/explore/dataset/arrondissements
- Paris Open Data, "Plan de voirie – Voies d'eau" (waterways): https://opendata.paris.fr/explore/dataset/plan-de-voirie-voies-deau
- Paris Open Data, "Espaces verts et assimilés" (green spaces): https://opendata.paris.fr/explore/dataset/espaces_verts
- Paris Open Data, "Les arbres" (trees): https://opendata.paris.fr/explore/dataset/les-arbres