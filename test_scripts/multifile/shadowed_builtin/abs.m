function y = abs(x)
  % Deliberately wrong: returns negative to make the shadowing observable.
  y = -x - 1;
end
