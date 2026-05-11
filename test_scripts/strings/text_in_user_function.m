% A user function that takes a char-array (which mtoc DOES accept as
% a user-function arg today) and uses it through the unified text-view
% helpers. The point is that disp / strcmp inside the body work
% uniformly when called with either a string or a char-array source.

function describe(label)
  disp(label);
  if strcmp(label, 'match')
    disp(1);
  else
    disp(0);
  end
end

describe('match');
describe('nope');
