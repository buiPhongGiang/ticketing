/** Default artwork per event (the contract stores no image). Files and credits: public/art. Icons are drawn, see ui.tsx. */
const photos = ['neon', 'indie', 'rooftop', 'lantern', 'soundcheck', 'crowd'];
export const eventPhoto = (id: number) => `art/events/${photos[id % photos.length]}.jpg`;
