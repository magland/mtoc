% Child overrides a parent method. Dot-syntax dispatches to the
% child's version because numbl's findDefiningClass walks the chain
% starting at the receiver's class.
classdef Animal
  properties
    legs
  end
  methods
    function obj = Animal(n)
      obj.legs = n;
    end
    function r = sound(obj)
      r = obj.legs;
    end
  end
end

classdef Cat < Animal
  properties
    color
  end
  methods
    function obj = Cat(n, c)
      obj.legs = n;
      obj.color = c;
    end
    function r = sound(obj)
      r = obj.color + obj.legs;
    end
  end
end

a = Animal(4);
c = Cat(4, 100);
disp(a.sound());
disp(c.sound());
disp(sound(a));
disp(sound(c));
