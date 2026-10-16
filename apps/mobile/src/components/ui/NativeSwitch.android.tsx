import { NativeThemeHost } from "./NativeThemeHost.android";
import { Switch as ComposeSwitch } from "@expo/ui/jetpack-compose";
import { View } from "react-native";
import type { ThemedSwitchProps } from "./NativeSwitch.types";

import { useControlTheme } from "./useControlTheme";

// Like RN's Switch, the host claims the touch so a parent Pressable never becomes
// the JS responder. That responder's view intercepts the gesture on Android,
// cancelling the Compose tap and firing the row's onPress instead.
const claimTouch = {
  onStartShouldSetResponder: () => true,
  onResponderTerminationRequest: () => false,
};

/** Material's native switch, with the same palette and accessibility contract as our RN controls. */
export function NativeSwitch(props: ThemedSwitchProps) {
  const { colors } = useControlTheme();
  const toggle = () => {
    if (!props.disabled) props.onValueChange?.(!props.value);
  };

  return (
    <View
      accessible
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityRole="switch"
      accessibilityState={{ checked: Boolean(props.value), disabled: Boolean(props.disabled) }}
      accessibilityActions={[{ name: "activate", label: "Toggle" }]}
      onAccessibilityAction={toggle}
      style={props.style}
      testID={props.testID}
    >
      <View importantForAccessibility="no-hide-descendants">
        <NativeThemeHost
          {...claimTouch}
          ignoreSafeAreaKeyboardInsets
          style={{ width: 52, height: 48 }}
        >
          <ComposeSwitch
            value={Boolean(props.value)}
            enabled={!props.disabled}
            onCheckedChange={props.onValueChange ?? undefined}
            colors={{
              checkedTrackColor: colors["--color-switch-active-track"],
              checkedThumbColor: colors["--color-switch-active-thumb"],
              checkedBorderColor: colors["--color-switch-active-track"],
              uncheckedTrackColor: colors["--color-switch-inactive-track"],
              uncheckedThumbColor: colors["--color-switch-inactive-thumb"],
              uncheckedBorderColor: colors["--color-switch-inactive-thumb"],
            }}
          />
        </NativeThemeHost>
      </View>
    </View>
  );
}
