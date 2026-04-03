# Google Places API — Type Reference

Source: https://developers.google.com/maps/documentation/places/web-service/place-types

## Food & Drink Types (Table A — usable as filters)

### Cafe / Coffee / Breakfast
`cafe`, `coffee_shop`, `coffee_roastery`, `coffee_stand`, `breakfast_restaurant`, `brunch_restaurant`, `bakery`, `bagel_shop`, `cake_shop`, `pastry_shop`, `diner`, `bistro`, `cat_cafe`, `dog_cafe`, `tea_house`, `juice_shop`, `donut_shop`, `acai_shop`

### Bar / Pub / Nightlife
`bar`, `pub`, `cocktail_bar`, `sports_bar`, `wine_bar`, `hookah_bar`, `lounge_bar`, `beer_garden`, `brewpub`, `irish_pub`, `bar_and_grill`

### Restaurant (general)
`restaurant`, `fast_food_restaurant`, `fine_dining_restaurant`, `family_restaurant`, `buffet_restaurant`, `food_court`, `gastropub`

### Specific Restaurant Types
American: `american_restaurant`, `hamburger_restaurant`, `hot_dog_restaurant`, `soul_food_restaurant`
Asian: `chinese_restaurant`, `japanese_restaurant`, `korean_restaurant`, `thai_restaurant`, `vietnamese_restaurant`, `indian_restaurant`, `sushi_restaurant`, `ramen_restaurant`, `asian_restaurant`, `dim_sum_restaurant`, `dumpling_restaurant`, `hot_pot_restaurant`
European: `italian_restaurant`, `french_restaurant`, `greek_restaurant`, `spanish_restaurant`, `german_restaurant`, `polish_restaurant`
Middle Eastern: `lebanese_restaurant`, `turkish_restaurant`, `middle_eastern_restaurant`, `falafel_restaurant`, `shawarma_restaurant`, `kebab_shop`, `gyro_restaurant`, `halal_restaurant`
Other: `mexican_restaurant`, `seafood_restaurant`, `steak_house`, `vegan_restaurant`, `vegetarian_restaurant`, `pizza_restaurant`, `sandwich_shop`, `barbecue_restaurant`, `mediterranean_restaurant`

### Dessert / Snacks
`ice_cream_shop`, `dessert_shop`, `dessert_restaurant`, `candy_store`, `chocolate_shop`, `snack_bar`, `confectionery`

### Nightlife / Entertainment Venues (NOT food primarily)
`night_club`, `live_music_venue`, `event_venue`, `karaoke`

## Intent → Type Mapping

### "Cafe / Coffee / Breakfast"
**Good types (need ≥1):** `cafe`, `coffee_shop`, `coffee_roastery`, `breakfast_restaurant`, `brunch_restaurant`, `bakery`, `bagel_shop`, `diner`, `bistro`, `tea_house`
**Hard exclude (any present = skip):** `pub`, `night_club`, `live_music_venue`, `event_venue`, `sports_bar`, `casino`
**Note:** `bar` alone is not a hard exclude — many cafes have it tagged alongside breakfast types. `hookah_bar` similarly appears alongside legitimate cafe types (e.g. Kaneffi); use judgment.

### "Restaurant / Dinner"
**Good types:** `restaurant` + any cuisine type
**Hard exclude:** `night_club`, `live_music_venue`
**Minimum rating:** 4.0+ recommended

### "Bar / Drinks"
**Good types:** `bar`, `pub`, `cocktail_bar`, `wine_bar`, `beer_garden`, `brewpub`
**No hard excludes**

### "Bakery / Pastry"
**Good types:** `bakery`, `pastry_shop`, `cake_shop`, `bagel_shop`, `donut_shop`
**Hard exclude:** `pub`, `night_club`

### "Ice Cream / Dessert"
**Good types:** `ice_cream_shop`, `dessert_shop`, `dessert_restaurant`, `candy_store`

## Table B types (returned in responses, NOT usable as search filters)
`establishment`, `food`, `point_of_interest`, `store`, `service` — these appear in every result and have no filtering value. Ignore for intent matching.

## Catering / Services (not walk-in venues)
`catering_service` — Google sometimes returns these for food queries. Exclude if intent is "walk-in" dining.
